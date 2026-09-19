# shopflow-inventory

The inventory microservice of the ShopFlow composed runtime. It is the **single owner of the product
catalog and of every stock change**, and it exposes an idempotent stock-decrement interface plus a
compensating release interface for the order orchestrator. It replaces the catalog and stock
responsibility of the retired monolith.

- Node.js 22, TypeScript (ESM, `NodeNext`), Express 5, `pg` 8. Every version is pinned in
  `package.json` and `package-lock.json`.
- HTTP contract: `apis/inventory-service-api.md` **version 1** (unchanged, see
  [Contract ownership](#contract-ownership)).
- Schema authority: `schema/inventory-schema.sql` (applied by the infra repository as the init script of
  this service's database).

## Responsibility and owned datum

| Owned | Where |
| --- | --- |
| `products` - id, sku, name, `price_cents`, `stock` | this service's own database |
| `stock_decrements` - the idempotency ledger, one row per order id that reached the service | this service's own database |

This service is the only writer of both tables, and it calls nothing: inventory has no outbound
service dependency. Everything about order lifecycle and notifications is out of scope here.

**This service never touches order data or notification data.** It has no knowledge of order status,
shipping or delivery, it holds no order or notification table, and it never connects to another
service's database - the order orchestrator reaches it only through the two documented HTTP calls, and
the gateway only reads the catalog. The repository contains exactly one database variable,
`INVENTORY_DATABASE_URL`; no second database name or foreign host may be introduced here.

## HTTP API (version 1)

Base URL in the composed runtime: `http://inventory:3003`. All payloads are JSON; every error uses the
two-field envelope `{"error": string, "code": string}`; money is integer cents; `x-correlation-id` is
echoed when supplied and generated when missing.

| Endpoint | Success | Failures |
| --- | --- | --- |
| `GET /health` | `200 {"ok":true}` (no database round trip, used as the Compose healthcheck gate) | - |
| `GET /products` | `200` array of products ordered by `id` | - |
| `GET /products/:id` | `200` product | `404 {"error":"Product not found","code":"NOT_FOUND"}` |
| `POST /stock-decrements` | `201` first execution, `200` idempotent replay with `x-idempotent-replay: true` | `400 INVALID`, `404 NOT_FOUND`, `409 INSUFFICIENT_STOCK`, `409 STATE_CONFLICT` (already released), `500` |
| `POST /stock-decrements/:orderId/release` | `200` first release and repeated release (identical body) | `404 NOT_FOUND`, `409 STATE_CONFLICT` |

`Idempotency-Key: <orderId>` is required on the decrement; a missing header or a body `orderId` that
differs from it is `400 INVALID`.

## Stock rules

- **Decrement.** The ledger row and the conditional update
  (`UPDATE products SET stock = stock - $2 WHERE id = $1 AND stock >= $2`) commit in one transaction;
  `rowCount === 1` is required for success. A refused update records the outcome
  `INSUFFICIENT_STOCK` and changes nothing.
- **Replay.** A known `orderId` returns the recorded outcome with the recorded status code and body and
  never decrements again. The replay path is read-only: it touches neither `products` nor the ledger row.
- **Oversell protection.** The guarded update is the serialization point for concurrent orders, and
  `CHECK (stock >= 0)` in the schema is the second line of defense.
- **Release.** Stock is incremented by the recorded quantity in one guarded statement
  (`... WHERE order_id = $1 AND outcome = 'DECREMENTED' AND state = 'RECORDED'`), which also flips the
  ledger state to `RELEASED`, so the compensation happens at most once ever. A second release replays
  the recorded quantity instead of incrementing again and reports the product's current stock, which is
  exactly the first release's `remainingStock` as long as no other stock change happened in between.
- **Terminal states.** `DECREMENTED` (then `RELEASED` after compensation), `INSUFFICIENT_STOCK` and
  `NOT_FOUND`. Rows for rejected outcomes are recorded too, so a retry replays them.
- No cancellation, reservation, expiry, backorder or restock feature exists: the decrement and the
  release above are the only stock mutations.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3003` | HTTP port |
| `INVENTORY_DATABASE_URL` | `postgres://inventory:inventory@localhost:5432/inventory` (see `.env.example`) | the connection string of this service's own database |

These two names are the complete configuration surface. The values in `.env.example` are
placeholder-free local development defaults, not secrets; the composed runtime injects the same names.

## Source layout

```
src/domain/               product value object, ledger record, request errors
src/application/          catalog and stock use cases (the two stock mutations)
src/ports/                catalog, ledger and transaction ports
src/adapters/http/        the five documented endpoints and the error envelopes
src/adapters/postgres/    pg implementations of the ports (the only SQL in the repository)
src/composition.ts        production wiring, also used by the tests
src/main.ts               configuration, pool, HTTP server, graceful shutdown
schema/inventory-schema.sql   authoritative DDL and deterministic seed
```

## Local checks

```sh
npm ci                        # install from the lockfile
npm run build                 # tsc, emits dist/ and type-checks the tests
npm test                      # unit tests (no database) + integration tests (real PostgreSQL)
```

The integration tests need a reachable PostgreSQL 17 database. They read `INVENTORY_DATABASE_URL` and
fall back to its documented local default, and they re-apply `schema/inventory-schema.sql` before every
test, so they are re-runnable and prove the delivered DDL on a real server:

```sh
docker run -d --name shopflow-inventory-test-db -e POSTGRES_DB=inventory -e POSTGRES_USER=inventory \
  -e POSTGRES_PASSWORD=inventory -p 5432:5432 postgres:17-alpine
npm test
docker rm -f shopflow-inventory-test-db       # tear the throwaway database down again
```

Without a reachable database the integration tests are reported as **skipped** together with the exact
reason (which address was unreachable and how to provide one) - they never turn into a passing green.

Build and run the container image on its own:

```sh
docker build -t shopflow-inventory:local .
docker run --rm -p 3003:3003 -e INVENTORY_DATABASE_URL=postgres://inventory:inventory@host.docker.internal:5432/inventory shopflow-inventory:local
curl -s http://localhost:3003/health
```

In the composed runtime (`docker compose up --build` in the infra repository) this service is reached
at `http://inventory:3003`, keeps no published host port and is gated by its own healthcheck.

### Test ids

| Id | Scope |
| --- | --- |
| `INV-U1` | catalog endpoints: seed, ordering, exactly the five documented fields, `404 NOT_FOUND` |
| `INV-U2` | `INSUFFICIENT_STOCK` recorded without a stock mutation |
| `INV-U3` | replay of a recorded decrement and of a recorded `NOT_FOUND` without a second mutation |
| `INV-U4` | release of a `DECREMENTED` row, and release replay as a no-op |
| `INV-U5` | release of a non-decremented row - `409 STATE_CONFLICT` |
| `INV-U6` | release of an unknown order id - `404 NOT_FOUND`, no ledger row created |
| `INV-U7` | decrement of an already released order - `409 STATE_CONFLICT` |
| `INV-U8` | the six documented error envelopes |
| `INV-U9` | every `INVALID` validation branch (header, order id, product id, quantity, malformed JSON) |
| `INV-U10` | correlation id echo/generation, unknown route envelope |
| `INV-U11` | `/health` without a database round trip, `500` envelope on driver failure |
| `INV-U12` | repository scope: no foreign table SQL, exactly one database variable name |
| `INV-I1` | real decrement of 3 from `product-a`: `totalCents 3600`, `remainingStock 7`, persisted |
| `INV-I2` | five calls with one order id: stock changed once, recorded body replayed |
| `INV-I3` | release restores the stock exactly once and is idempotent |
| `INV-I4` | concurrent decrements beyond the stock: exactly one wins, `stock >= 0`, deltas match |
| `INV-I5` | `GET /products` matches the seed exactly and is ordered by `id` |
| `INV-I6` | five concurrent calls for one order id decrement exactly once |
| `INV-I7` | the recorded outcome, the stock and the ledger survive a service restart |
| `INV-I8` | the applied schema keeps its constraints, index and seed on a real server |
| `INV-I9` | rejected requests are recorded, replayed, and never mutate stock |

The ownership guards of the infra repository (`tests/ownership/`, G1-G4) are the authoritative
architecture fitness functions; `INV-U12` asserts the same two invariants from inside this repository.

## Contract ownership

`apis/inventory-service-api.md` version 1 is frozen: it is the interface the order orchestrator and the
gateway hold copies of. This implementation adds no endpoint, no response field and no status code
beyond that contract, and no contract change was needed - the version stays **1**.
