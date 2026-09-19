# shopflow-orders

The ShopFlow orders service: the **single owner of the order lifecycle and of order persistence**.
It replaces the order responsibility of the retired monolith backend and is the producer of
`apis/orders-service-api.md` version 1 (consumed by `shopflow-gateway`).

## Responsibility and owned datum

This service owns one database (its only database variable is `ORDERS_DATABASE_URL`) with exactly
three tables, applied verbatim from `schema/orders-schema.sql`:

| Table | Datum |
| --- | --- |
| `orders` | the order: id, customer email, `status` (`CONFIRMED`/`SHIPPED`), product reference, quantity, total in integer cents, creation timestamp |
| `order_operations` | the durable **order-creation saga**: one row per creation intent, written before any remote call |
| `notification_outbox` | the durable **order-confirmation intent**, written in the same local transaction as the order row |

`orders.product_id` is deliberately **not** a foreign key: the product row lives in the inventory
service's database and the integrity of the reference comes from the creation saga (an order exists
only after inventory recorded a decrement for its id). This service holds no product catalog, no
stock rule, no provider credential and no notification record; it talks to `shopflow-inventory` and
`shopflow-notifications` through their frozen version 1 HTTP contracts only, and it never writes to
another service's database.

## Layout (hexagonal)

```
src/domain          order, saga states, outbox policy, request validation, error vocabulary
src/application     OrderService (read side + ship), saga/ (creation, recovery, outbox dispatcher)
src/ports           OrderStore + OrderUnitOfWork, InventoryClient, NotificationClient
src/adapters/http   the five documented endpoints of this service
src/adapters/postgres  the PostgreSQL implementation of OrderStore (transaction-scoped)
src/adapters/inventory, src/adapters/notifications   the two frozen HTTP clients
src/worker          the saga-recovery loop and the outbox-dispatch loop
src/main.ts         configuration, pool, HTTP server, graceful shutdown
src/test-support    doubles and the integration environment (unit and integration layers)
```

## Endpoints

| Method and path | Answers |
| --- | --- |
| `GET /health` | `200 {"ok":true}` (no database round trip; used as the Compose healthcheck) |
| `POST /orders` | `201` order (`CONFIRMED`), `200` + `x-idempotent-replay: true` for a known client `Idempotency-Key`, `400 INVALID`, `400 INSUFFICIENT_STOCK`, `404 NOT_FOUND` (unknown product), `500` (order committed, confirmation not delivered), `503 UNAVAILABLE` (decrement outcome unknown) |
| `GET /orders/:id` | `200` order, `404 {"error":"Order not found","code":"NOT_FOUND"}` |
| `POST /orders/:id/ship` | `200` order (`SHIPPED`), `409 {"error":"Only CONFIRMED orders can be shipped","code":"INVALID_STATUS"}`, `404` |
| `GET /orders/:id/operations` | internal diagnostic of the saga: `state` (`STARTED`, `DECREMENTED`, `COMPLETED`, `ABORTED_NOT_FOUND`, `ABORTED_INSUFFICIENT_STOCK`, `UNCERTAIN`), `decrementOutcome`, `notificationOutboxState`, `attempts` |

The order value object is exactly the legacy one: `{id, customerEmail, status, productId, quantity,
totalCents, createdAt}` with a UUID id and an ISO 8601 UTC `createdAt`. Every error body uses the
two-field envelope, except the documented `500` body, which carries `error` only. There is **no
cancellation route** and no other capability beyond the five routes above.

Shipping is one conditional statement - `UPDATE orders SET status='SHIPPED' WHERE id=$1 AND
status='CONFIRMED' RETURNING ...` - which is what serializes concurrent ship calls. It touches
neither inventory nor notifications.

## Order creation: the durable saga

`POST /orders` is a saga over the two frozen interfaces (`design/order-creation-saga.md`):

1. validate the input (the legacy rejection, no saga row, no remote call);
2. a known client `Idempotency-Key` resolves the existing saga instead of starting a second one;
3. generate the order id (`crypto.randomUUID()`) **first** - it is the order primary key and the
   inventory idempotency key - and commit the saga row (`state = STARTED`) **before any remote call**;
4. `POST /stock-decrements` with `Idempotency-Key: <orderId>`, up to `INLINE_CALL_ATTEMPTS`
   attempts with a short backoff, `UPSTREAM_TIMEOUT_MS` per attempt;
5. inventory `404` → saga `ABORTED_NOT_FOUND` → `404 NOT_FOUND` (no order, no stock change);
6. inventory `409 INSUFFICIENT_STOCK` → saga `ABORTED_INSUFFICIENT_STOCK` → `400 INSUFFICIENT_STOCK`
   (no order, no stock change, no notification);
7. inventory `2xx` → saga `DECREMENTED`, with the inventory price snapshot;
8. **one local transaction** writes the order row (`CONFIRMED`, `totalCents = unitPriceCents *
   quantity`), the outbox row (`PENDING`) and the saga completion (`COMPLETED`) - or none of them;
9. dispatch the confirmation with `Idempotency-Key: ORDER_CONFIRMATION:<orderId>`: success → outbox
   `DELIVERED` and `201`; failure → outbox stays `PENDING` with a retry scheduled and the caller sees
   `500` while the order stays committed (exactly the legacy behaviour, but the intent is durable).

Unanswerable inventory outcomes (timeout, connection failure, 5xx, undocumented answer) leave the
saga `UNCERTAIN` and answer `503 UNAVAILABLE`; the recovery worker resolves it by replaying the same
order id, so the recorded outcome decides - never a second decrement.

When the local transaction cannot proceed, the confirmed decrement is **compensated** with
`POST /stock-decrements/:orderId/release`. A successful release is recorded as
`decrement_outcome = 'RELEASED'` on the saga row: the saga is then terminal, no order is created and
the worker never completes it forward. If the release cannot be confirmed, the saga stays open
(`DECREMENTED` + the failure in `last_error`) and the worker keeps retrying it - a saga is never
aborted without a successful release. The DDL's five saga states plus `UNCERTAIN` are the whole
vocabulary; `RELEASED` is the recorded *outcome* of the compensated decrement, which is why it lives
in `decrement_outcome` and not in `state`.

Worker settings are configurable and can be disabled (`SAGA_INTERVAL_MS = 0`, `OUTBOX_INTERVAL_MS =
0`), which is how the unit tests run without timers and how the integration tests use intervals of a
few hundred milliseconds. Recovery is resume-forward: it reads the persisted state and continues
from there, nothing is kept in process memory. A `STARTED` saga is only taken over after an
`UPSTREAM_TIMEOUT_MS * INLINE_CALL_ATTEMPTS` grace period, so an in-flight request is never stolen.

### Outbox policy

The confirmation is a durable intent, not a best-effort call. The dispatcher selects `PENDING` rows
whose `next_attempt_at` has passed, re-dispatches them, records the failure in `last_error` and
schedules a bounded exponential backoff (`OUTBOX_BACKOFF_BASE_MS`, factor 2, cap 30 s). Delivery is
logically exactly-once: the notifications service enforces `UNIQUE (type, order_id)` and every
dispatch carries `Idempotency-Key: ORDER_CONFIRMATION:<orderId>`, so a duplicate dispatch (inline
plus background, or two instances) cannot produce a second confirmation.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3002` | HTTP port |
| `ORDERS_DATABASE_URL` | - (required) | the one database this service owns |
| `INVENTORY_URL` | `http://localhost:3003` | frozen inventory interface |
| `NOTIFICATIONS_URL` | `http://localhost:3004` | frozen notifications interface |
| `SAGA_INTERVAL_MS` | `1000` | recovery loop period (`0` disables) |
| `OUTBOX_INTERVAL_MS` | `1000` | outbox dispatcher period (`0` disables) |
| `OUTBOX_BACKOFF_BASE_MS` | `250` | outbox backoff base (factor 2, cap 30 s) |
| `INLINE_CALL_ATTEMPTS` | `2` | inventory attempts inside one `POST /orders` |
| `UPSTREAM_TIMEOUT_MS` | `3000` | per-attempt timeout of every outbound call |

`.env.example` documents the same nine names with local, credential-free defaults.
`ORDERS_DATABASE_URL` is the **only** database variable name in this repository.

## Local checks

```sh
npm ci
npm run build                 # tsc -p tsconfig.build.json -> dist/main.js
npm start                     # node dist/main.js (needs a database + the two interfaces)
npm run typecheck             # the whole tree, tests included
npm test                      # unit + integration (see below)
docker build -t shopflow-orders:local .   # multi-stage node:22-alpine image, EXPOSE 3002
```

`npm test` runs three layers:

| Layer | Files | Needs |
| --- | --- | --- |
| `ORD-U*` unit | `src/adapters/http/orders-http.unit.test.ts`, `src/application/saga/order-creation.unit.test.ts` | nothing (recording doubles, in-memory persistence, workers disabled) |
| `ORD-I*` integration | `src/integration/orders.integration.test.ts` | Docker (a real PostgreSQL 17 container) and the Wave 1 repositories `shopflow-inventory` and `shopflow-notifications` next to this one |
| `ORD-S1` scope | `src/repository-scope.test.ts` | nothing (static scan of this repository) |

The integration environment starts a real PostgreSQL 17 (`postgres:17-alpine`, or the server of
`ORDERS_DATABASE_URL` when it is set and reachable), creates one isolated database per service,
applies each owner's own DDL (its own `schema/orders-schema.sql` here, the owners' files for the two
dependency databases) and runs the **real** `shopflow-inventory` and `shopflow-notifications`
services as child processes, with a stubbed provider behind the notifications service. The orders
application itself runs through the production composition root (`src/composition.ts`), so the tests
exercise what the container runs. An unreachable Docker daemon fails the integration tests with the
reason instead of skipping them.

The manual end-to-end check of the composed runtime lives in `shopflow-infra`:

```sh
cd ../shopflow-infra && docker compose up --build -d
curl -i -X POST http://localhost:3001/orders -H "content-type: application/json" \
     -d '{"productId":"product-a","quantity":3,"customerEmail":"buyer@example.com"}'
curl -i -X POST http://localhost:3001/admin/orders/<id>/ship
```

## Notes and deliberate decisions

- **The price snapshot comes from the decrement response.** `POST /stock-decrements` answers the
  inventory service's own `unitPriceCents`/`totalCents` for the order id, which is the atomic
  snapshot of the price the stock was taken at. No second catalog call is made, so `totalCents`
  cannot disagree with the decrement that authorised it. This service never computes a price.
- **`totalCents` is integer cents** and is stored as such; timestamps are ISO 8601 UTC.
- **The outbox row is born `PENDING` inside the order transaction** and is marked `DELIVERED` only
  after a 2xx answer from the notifications service; `ORD-U1` asserts both the `PENDING` state at
  dispatch time and the `PENDING`-after-failure behaviour in `ORD-U9`.
- **A client `Idempotency-Key` longer than 255 characters is rejected with the legacy `400 INVALID`**
  rather than stored: the key is durable state, so it is bounded. A blank header counts as absent,
  which is exactly the legacy behaviour.
- **`GET /orders/:id/operations`** exists so recovery, compensation and outbox state can be asserted
  without reading the database; it is not part of the public contract.
