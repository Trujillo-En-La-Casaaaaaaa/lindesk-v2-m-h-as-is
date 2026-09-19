# ShopFlow Infrastructure

Owner of the composed ShopFlow runtime, its database provisioning and the proof that the migration
preserves externally observable behaviour.

`docker compose up --build` is the only supported start path and `docker compose down -v` is the only
supported reset path. Nine services are composed: the web UI, four application services, the
deterministic notification provider stand-in and three **service-owned** databases. The retired
shared-database deployment (one `db` service holding `products` and `orders`, one monolithic `api`
built from the retired `shopflow-api` repository) is gone: nothing here builds, starts or references
it, and `postgres/init.sql` was deleted with no successor as a shared schema authority.

## Start

```sh
docker compose up --build      # or: npm run up
```

Open <http://localhost:3000>. The public API is <http://localhost:3001> and recorded order
confirmations can be inspected at <http://localhost:4010/notifications>. All services are local: no
cloud service, no external dependency and no internet access is needed at runtime.

To restore the exact seed state, run `docker compose down -v` before starting again
(`npm run down` then `npm run up`).

## Host ports

| Host port | Service | Purpose |
| --- | --- | --- |
| `3000` | `web` | UI (nginx serves the SPA and strips `/api` before proxying to the gateway) |
| `3001` | `gateway` | public API - the host port of the retired monolith, preserved |
| `4010` | `notification-emulator` | provider inspection (`GET /notifications`) |

Database ports are deliberately **not** published: `orders-db`, `inventory-db` and
`notifications-db` are reachable only inside the compose network, so no host process can bypass a
service interface and no service can reach another service's data.

## Service and database ownership

| Service | Build context | Owns | Database URL it receives | Depends on (healthy) |
| --- | --- | --- | --- | --- |
| `web` | `../shopflow-web` | nothing | none | `gateway` |
| `gateway` | `../shopflow-gateway` | no datum, no persistence | none (by design) | `orders`, `inventory` |
| `orders` | `../shopflow-orders` | orders + the creation saga and notification outbox | `ORDERS_DATABASE_URL` -> `orders-db` | `orders-db`, `inventory` |
| `inventory` | `../shopflow-inventory` | the product catalog and all stock changes | `INVENTORY_DATABASE_URL` -> `inventory-db` | `inventory-db` |
| `notifications` | `../shopflow-notifications` | notification records and delivery state | `NOTIFICATIONS_DATABASE_URL` -> `notifications-db` | `notifications-db`, `notification-emulator` |
| `notification-emulator` | `./notification-emulator` | nothing (external provider stand-in) | none | - |
| `orders-db` | `postgres:17-alpine` | `orders-db` | - | - |
| `inventory-db` | `postgres:17-alpine` | `inventory-db` | - | - |
| `notifications-db` | `postgres:17-alpine` | `notifications-db` | - | - |

Each application service receives exactly one `*_DATABASE_URL` and it names its own database. The
gateway owns no datum and therefore receives no database variable at all. The same rules are
documented per variable in [`runtime/environment-contract.md`](runtime/environment-contract.md) and
mirrored in the root [`.env.example`](.env.example); they are enforced by ownership guard G3 in
`tests/ownership/`.

Startup ordering is healthcheck-gated: `inventory-db` -> `inventory`; `notifications-db` + provider
-> `notifications`; `orders-db` + `inventory` -> `orders`; `orders` + `inventory` -> `gateway`;
`gateway` -> `web`. Every edge is `depends_on` with `condition: service_healthy`.

## Database provisioning, seed and reset

| Volume | Database service | Init script | Content |
| --- | --- | --- | --- |
| `orders-data` | `orders-db` | [`postgres/orders-init.sql`](postgres/orders-init.sql) | the orders schema: `orders`, `order_operations`, `notification_outbox`; no rows |
| `inventory-data` | `inventory-db` | [`postgres/inventory-init.sql`](postgres/inventory-init.sql) | the inventory schema: `products`, `stock_decrements`, plus the deterministic seed |
| `notifications-data` | `notifications-db` | [`postgres/notifications-init.sql`](postgres/notifications-init.sql) | the notifications schema: `notifications`, `notification_attempts`; no rows |

The three init scripts are applied copies of the owning repositories' authoritative schema files, each
mounted only into its own database container with its own volume and local fixture credentials; no init
script is mounted twice. The deterministic catalog seed is preserved verbatim from the legacy shared
database:

- `product-a` / `SKU-A` / `Product A` / 1200 cents / stock **10**
- `product-b` / `SKU-B` / `Product B` / 2500 cents / stock **5**

Reset semantics: the seed is applied when a volume is created, so `docker compose down -v` followed by
`docker compose up --build` restores `product-a` stock 10, `product-b` stock 5 and empty order and
notification tables. An already-initialised volume is never re-seeded.

## Notification provider

The notification provider is a **local deterministic stand-in for an external service**:
`notification-emulator/` speaks the unchanged external provider contract (`POST /notifications`,
`GET /notifications`, `GET /health`, sequential `notification-NNNN` ids, port 4010) and is the only
component in this repository that is not first-party application code. In a real deployment a concrete
external provider substitutes behind that same contract. It keeps no durable state of its own and is
byte-identical to the pre-migration version; delivery reliability belongs to `shopflow-notifications`.
The contract is documented in the handoff copy of the provider contract and must not be changed by the
migration.

## Verification

```sh
docker compose config          # renders without warnings, no retired reference
docker compose up --build -d   # nine services reach healthy
docker compose ps              # evidence: every service healthy (or exited 0 for one-shot init)
docker compose down -v         # reset to the exact seed

npm test                       # node --test tests/            behaviour preservation + guards
npm run test:preservation      # node --test tests/behavior-preservation.test.js
npm run test:guards            # node --test tests/ownership/  no stack needed
```

- `tests/behavior-preservation.test.js` - the black-box suite for scenarios P1-P10 (catalog, order
  creation, validation no-ops, detail/ship, provider outage, cancellation prohibition, duplicate
  dispatch, ambiguous failure with restart and recovery, composed runtime readiness). It runs against
  `BASE_URL`/`PROVIDER_URL` only and is driven by the same file on the legacy and the migrated stack.
- `tests/ownership/ownership-guards.test.js` - guards G1-G7 (single writer per datum, no cross-service
  database access, exactly one database per service, no shared persistence shortcuts, no gateway domain
  logic, exactly six repositories, no new public capability).
- `tests/README.md` documents both suites, their configuration and the full traceability matrix;
  `tests/baseline/` holds the required legacy baseline record and the raw run outputs.

Partial runtime verification (database provisioning, seed, reset, provider contract) can be repeated
without the missing application repositories:

```sh
docker compose up -d orders-db inventory-db notifications-db
docker compose ps                                       # three services healthy, no published port
docker compose exec -T inventory-db psql -U inventory -d inventory \
     -c "select id, sku, name, price_cents, stock from products order by id"
docker compose exec -T orders-db psql -U orders -d orders -c "\dt"
docker compose exec -T notifications-db psql -U notifications -d notifications -c "\dt"
docker compose up -d --build notification-emulator && curl -i http://localhost:4010/notifications
docker compose down -v
```

## Status of this delivery

The runtime, the seeds, the environment contract and both suites are complete. Verification is split
as follows; the raw evidence is in [`tests/baseline/`](tests/baseline/).

Verified with real containers - full record in
[`tests/baseline/runtime-probe-evidence.txt`](tests/baseline/runtime-probe-evidence.txt):

- `docker compose config` renders without warnings and without any retired reference, and matches
  `runtime/compose-plan.md` field by field (build contexts, images, published ports, volumes,
  init-script mount targets, healthcheck cadence and test commands: 54/54 checks).
- The three database services start, reach `healthy`, apply their own init script and publish no host
  port (only `5432/tcp` inside the compose network, `Publishers[].PublishedPort = 0`).
- Each database holds exactly its owner's schema and nothing else (`orders-db`: `orders`,
  `order_operations`, `notification_outbox`; `inventory-db`: `products`, `stock_decrements`;
  `notifications-db`: `notifications`, `notification_attempts`), so the deleted shared
  `postgres/init.sql` has no successor as a schema authority.
- The deterministic seed is applied: `product-a` 1200/stock 10, `product-b` 2500/stock 5, with empty
  order and notification tables; after mutating the data, `docker compose down -v` + `up -d` restores
  exactly that state.
- The unchanged provider emulator builds, becomes healthy and serves its contract on host port 4010
  (`GET /health` -> `200 {"ok":true}`, valid `POST /notifications` -> `201 notification-0001` echoing
  the three legacy fields, wrong type or missing order id -> `400 {"error":"Invalid notification"}`,
  `GET /notifications` -> the stored record). It was also re-verified **as the delivered compose
  service** (`docker compose up -d --build notification-emulator` from the repository root: healthy,
  `0.0.0.0:4010->4010/tcp`, healthcheck command exits 0 inside the container), with the handoff's
  inspection command `curl -i http://localhost:4010/notifications` run verbatim.
- The provider's `stop`/`start` round trip - which P6 and criterion 8 depend on - was exercised in the
  delivered project: stopping makes port 4010 unreachable (`HTTP code 000`), starting returns the
  service to `healthy`, and the restart resets the provider's in-process record list
  (`GET /notifications` -> `[]`). That behaviour is consistent with the provider contract and is now
  accounted for by the P6 assertions instead of being assumed away.
- The `web` healthcheck command was executed in live containers on both official nginx bases
  (`nginx:alpine` resolves it through `wget`, `nginx:latest` through the `curl` fallback) and exits 0
  on both; the Node healthcheck command used by the four Node services exits 0 inside a
  `node:22-alpine` container.
- The `gateway` - the only implemented application service - was probed in isolation (its
  `depends_on` edges cannot be satisfied yet) using the build context and environment the compose file
  declares: it builds, publishes `3001:3001` and reports `healthy`; `GET /health` answers
  `200 {"ok":true}` with a generated `x-correlation-id` even while both upstreams are unreachable;
  `GET /products`, `POST /orders`, `GET /orders/:id` and `POST /admin/orders/:id/ship` answer the
  documented `503 {"error":"Upstream service unavailable","code":"UNAVAILABLE"}` (which also proves the
  `/admin/orders/:id/ship` -> `/orders/:id/ship` rewrite is proxied); `POST /orders/:id/cancel` and
  `DELETE /orders/:id` answer `404 {"error":"Not found","code":"NOT_FOUND"}`; `cors()` is enabled.
  Full record: [`tests/baseline/gateway-probe-evidence.txt`](tests/baseline/gateway-probe-evidence.txt).

Pending end-to-end verification. `docker compose up --build -d` for the **whole** stack cannot reach a
healthy steady state in this workspace yet, for two independent reasons:

1. Four of the six composed repositories are still missing: `../shopflow-web` is an empty directory and
   `../shopflow-orders`, `../shopflow-inventory`, `../shopflow-notifications` contain only their handoff
   folders (`../shopflow-gateway` is implemented). The build therefore stops at
   `failed to read dockerfile: open Dockerfile: no such file or directory`, every P* scenario is blocked
   at its setup step, and ownership guard G6 fails on exactly those four repositories - as designed.
   No domain success response (a real product list, order creation, order detail or ship) can be
   produced, because the three owning services have no image yet.
2. On this host, Docker Desktop for Windows cannot serve a bind-mounted file to a non-root container
   user when the source path is long: the mount returns `I/O error`, the postgres 17 entrypoint's own
   `ls /docker-entrypoint-initdb.d/` guard fails and the container exits 1. This is reproducible with a
   three-line unrelated compose project at this workspace path, while the identical delivered files and
   compose structure work from a short path - a host-environment property, not a defect of this
   repository. Start the stack from a short path (or shorten the workspace path) on this host.

Once (1) is satisfied, re-run `docker compose up --build -d`, `node --test tests/` (expect
`10 PASSED | 0 FAILED | 0 MIGRATION-ONLY`) and `node --test tests/ownership/` (expect `TOTAL | 7/7
PASSED`) from a short path, as described in [`tests/baseline/README.md`](tests/baseline/README.md).

## Layout

```
docker-compose.yml                 the nine-service composed runtime
.env.example                       compose-level environment contract (documentation only, no secrets)
runtime/environment-contract.md    every variable per service, per-database credentials, access rules
postgres/orders-init.sql           applied copy of the orders-owned schema
postgres/inventory-init.sql        applied copy of the inventory-owned schema + the deterministic seed
postgres/notifications-init.sql    applied copy of the notifications-owned schema
notification-emulator/             unchanged deterministic provider stand-in (server.py, Dockerfile)
tests/                             behaviour-preservation suite + ownership guards + baseline evidence
```
