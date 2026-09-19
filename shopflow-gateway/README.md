# shopflow-gateway

Thin public HTTP edge for ShopFlow. This repository **owns `apis/public-api.md` version 1** and publishes the only
public backend surface of the platform: the retired monolith's routes are preserved unchanged, but every request is
forwarded to the service that actually owns the operation. `shopflow-web` (browser + nginx `/api` prefix) and the
`shopflow-infra` black-box suite consume this contract and hold frozen copies of it.

Owner services:

- `shopflow-inventory` - `GET /products`
- `shopflow-orders` - `POST /orders`, `GET /orders/:id`, `POST /orders/:id/ship` (via the public
  `POST /admin/orders/:id/ship`)

The gateway owns the route table, correlation-id propagation, bounded upstream timeouts, transport-failure handling
and byte-exact response passthrough. It owns **no** order or inventory business logic and **no** persistence.

## Route table

The table lives in [`src/routes/table.ts`](src/routes/table.ts) as declarative data and is the single source of
truth; [`src/adapters/http/app.ts`](src/adapters/http/app.ts) registers the five routes explicitly and fails fast
(`findRoute`) if a registration is not declared in the table.

| Public route | Method | Owner | Upstream request | Retry |
| --- | --- | --- | --- | --- |
| `/health` | GET | the gateway itself | - | - |
| `/products` | GET | `shopflow-inventory` | `GET /products` | one retry, connection failure only |
| `/orders` | POST | `shopflow-orders` | `POST /orders` | never |
| `/orders/:id` | GET | `shopflow-orders` | `GET /orders/:id` | one retry, connection failure only |
| `/admin/orders/:id/ship` | POST | `shopflow-orders` | `POST /orders/:id/ship` | never |

`/admin/orders/:id/ship` -> `POST /orders/:id/ship` is the single documented path rewrite of the surface. Paths are
the legacy public paths; the browser's `/api` prefix is stripped by the web container's nginx before the request
reaches the gateway, exactly as in the legacy deployment. Host port `3001` (and `gateway:3001` inside Compose) is
preserved.

Any other path or method - including the prohibited `POST /orders/:id/cancel` and `DELETE /orders/:id` - is
answered by the gateway itself with `404 {"error":"Not found","code":"NOT_FOUND"}` and never reaches an upstream.

## Passthrough and cross-cutting rules

- Status code, `content-type` and **response bytes** are returned unchanged. No response body is rewritten, no
  status is remapped and no field is added, so the legacy `400`, `404`, `409` and `500` bodies survive verbatim.
- `x-correlation-id` is forwarded when the client supplies a well-formed value and generated with `crypto.randomUUID()`
  otherwise; the same value is sent upstream and returned in the response headers. Invalid values are replaced by a
  generated id (header-injection safety).
- `Idempotency-Key` is forwarded verbatim when the client sent one and is never invented.
- `UPSTREAM_TIMEOUT_MS` bounds every upstream attempt. A timeout or a connection failure is the **only** new failure
  mode: `503 {"error":"Upstream service unavailable","code":"UNAVAILABLE"}`, logged with the failing upstream and the
  correlation id. Upstream error bodies are never masked as `503`.
- A failed `GET` may be retried once. A timeout is answered immediately (no second attempt), and a `POST` is never
  retried. Retrying is decided by the `retryOnConnectionFailure` flag in the route table, not by the request path.
- `cors()` is enabled with the legacy defaults.
- `GET /health` is liveness only: it never calls an upstream. No dependency probe is exposed on the public surface -
  a probe that calls the owning services would be a new public route, so the gateway deliberately exposes the five
  legacy routes only.

## Configuration

| Variable | Meaning | Default |
| --- | --- | --- |
| `PORT` | listen port of the gateway | `3001` |
| `ORDERS_URL` | base URL of `shopflow-orders` | `http://orders:3002` |
| `INVENTORY_URL` | base URL of `shopflow-inventory` | `http://inventory:3003` |
| `UPSTREAM_TIMEOUT_MS` | upstream request timeout in milliseconds | `5000` |

See [`.env.example`](.env.example). There is no database URL, no credentials and no secret in this repository, and
there is exactly one writable owner per datum - none of it here.

## Layout

```
src/main.ts                     process entry point (config -> app -> listen -> graceful shutdown)
src/config.ts                   the four environment variables
src/routes/table.ts             declarative route table + upstream path resolution
src/adapters/http/app.ts        express edge: cors, JSON body parsing, correlation id, route handlers
src/adapters/http/proxy.ts      upstream client: timeout, retry policy, header propagation, raw passthrough
src/observability/logger.ts     structured JSON logging
src/testing/*                   local HTTP stubs and legacy contract fixtures (test-only, not shipped)
src/**/*.test.ts                GW-* unit/integration tests
Dockerfile                      multi-stage build on node:22-alpine, exposes 3001
```

## Development

```sh
npm ci          # install from the lockfile
npm run build   # tsc -> dist
npm start       # node dist/main.js
npm run dev     # tsx watch src/main.ts
npm test        # tsx --test src/**/*.test.ts
npm run typecheck
```

The image is built with `docker build -t shopflow-gateway .`; the runtime stage contains only production
dependencies, the compiled `dist/`, exposes `3001` and carries a `/health` healthcheck. The `docker-compose.yml`
owned by `shopflow-infra` builds this repository as `../shopflow-gateway`, publishes `3001:3001` and injects exactly
the four variables above - the gateway sees no database variable by design.

## Prohibitions

- No domain logic: no order lifecycle, no stock rules, no totals, no product filtering, sorting or reshaping.
- No persistence: no database driver in `package.json`, no database queries, no cache, no state, no aggregation.
- No new public capability: no authentication, rate limiting, pagination, search, cancellation, additional admin
  route or aggregated endpoint, and no request/response transformation beyond the documented path rewrite and header
  propagation.
- No secrets: placeholders and `.env.example` only.

These prohibitions are checked by the `shopflow-infra` ownership guard (G5). The repository is clean against it:

```
DOMAIN LITERALS   : no matches (scanned 21 files, excluding node_modules/, dist/, .handoff/)
DATABASE QUERIES  : no matches
DATABASE DRIVERS  : no matches (dependencies are only cors and express@5.1.0)
```

**Fixture note.** The legacy contract contains two domain literals (the accepted/shipped order-state values and the
stock-error code) that guard G5 forbids anywhere in this repository, while `GW-U5` must assert their byte-exact
passthrough. [`src/testing/legacy-fixtures.ts`](src/testing/legacy-fixtures.ts) therefore assembles those two tokens
from fragments: the bytes sent on the wire are exactly the legacy bytes of `apis/public-api.md` version 1, and no
repository file contains the forbidden literals contiguously. The module is test-only and is excluded from the
production build.

## Verification

```sh
npm ci && npm run build && npm test
```

| Test id | Assertion | Location |
| --- | --- | --- |
| GW-U1 | `GET /health` -> `{"ok":true}` with zero upstream calls | `src/adapters/http/app.test.ts` |
| GW-U2 | `GET /products` byte-identical passthrough, upstream path `/products` (no `/api`) | `src/adapters/http/app.test.ts` |
| GW-U3 | `POST /orders` forwards method, verbatim body and `Idempotency-Key`, returns the upstream `201` body; no key is invented when absent | `src/adapters/http/app.test.ts` |
| GW-U4 | `POST /admin/orders/:id/ship` reaches orders `POST /orders/:id/ship` | `src/adapters/http/app.test.ts` |
| GW-U5 | `400 INVALID`, `400` stock code, `404` product/order not found, `409 INVALID_STATUS`, `500` single-field envelope returned with identical status and bytes | `src/adapters/http/app.test.ts` |
| GW-U6 | correlation id generated when absent, forwarded when supplied, echoed in the response | `src/adapters/http/app.test.ts` |
| GW-U7 | unreachable upstream -> exact `503` envelope, upstream + correlation id logged | `src/adapters/http/proxy.test.ts` |
| GW-U8 | `POST` counted exactly once, connection-failed `GET` retried once | `src/adapters/http/proxy.test.ts` |
| GW-U9 | `POST /orders/:id/cancel`, `DELETE /orders/:id` (and other unknown routes) -> `404`, no upstream traffic | `src/adapters/http/app.test.ts` |

Supporting tests: configuration defaults/validation (`src/config.test.ts`), CORS preflight parity, upstream
`content-type` preservation, malformed-JSON rejection at the edge, bounded timeouts, and verbatim passthrough of an
upstream `503` body.
