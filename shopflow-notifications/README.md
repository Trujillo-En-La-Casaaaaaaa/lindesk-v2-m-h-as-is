# shopflow-notifications

Notification orchestration service of the shopflow platform (Node.js 22 + TypeScript ESM, Express 5, `pg` 8).

## Responsibility

- Own every notification record and its delivery state, and call the external notification provider.
- Preserve the legacy contract exactly: the provider payload stays
  `{"type":"ORDER_CONFIRMATION","orderId":"...","customerEmail":"..."}` with a 3 second timeout
  (`AbortSignal.timeout(3000)`), a provider failure is still reported synchronously to the caller, and the HTTP
  surface is the one frozen in `apis/notifications-service-api.md` version 1.
- Close the legacy gap: a committed order's confirmation is delivered **exactly once logically**. The record is
  persisted before the provider is called, repeated dispatches are deduplicated by `UNIQUE (type, order_id)`, and
  retries reconcile against the provider's inspection endpoint before posting again.

## Owned datum

- `notifications-db` only: the `notifications` table (one row per `(type, order_id)`, with `PENDING`/`DELIVERED`
  state) and its `notification_attempts` history. The authoritative DDL is `schema/notifications-schema.sql`, also
  applied by `shopflow-infra` as `postgres/notifications-init.sql`.
- Nothing else: this service never reads or writes order rows, order status or stock, never connects to another
  database, and holds no database URL other than `NOTIFICATIONS_DATABASE_URL`.
- The provider contract is unchanged and has no idempotency key; no provider-side deduplication is assumed.

## HTTP API (version 1)

Base URL in the composed runtime: `http://notifications:3004`. JSON only; errors always use the two-field
envelope `{"error": string, "code": string}`; `x-correlation-id` is echoed when supplied.

| Endpoint | Behaviour |
| --- | --- |
| `GET /health` | `200 {"ok":true}`. No provider call, no database access. |
| `POST /notifications/order-confirmations` | `Idempotency-Key: ORDER_CONFIRMATION:<orderId>` is required. `201` on first delivery, `200` with `x-idempotent-replay: true` for a replay or for a `PENDING` record this attempt delivered, `400 {"error":"Invalid notification","code":"INVALID"}`, `502 {"error":"Notification provider unavailable","code":"PROVIDER_UNAVAILABLE"}` (record stays `PENDING`), `500 {"error":"Internal server error","code":"INTERNAL"}`. |
| `GET /notifications` | `200` array of records, oldest first, with the documented fields: `id`, `type`, `orderId`, `customerEmail`, `status`, `attempts`, `providerRecordId`, `createdAt`. |

## Delivery, retry and dedupe policy

1. Validate the intent (`type === 'ORDER_CONFIRMATION'`, non-empty `orderId`, `customerEmail` containing `@`) and
   the idempotency key; both failures answer `400 INVALID`.
2. In one local transaction, upsert the record for `(type, order_id)` as `PENDING` (an existing row keeps its id,
   `attempts` and status) and commit it **before** the provider is called, so a crash cannot lose the
   notification.
3. If the record is already `DELIVERED`, answer `200` with the stored body and `x-idempotent-replay: true` and
   never call the provider again.
4. First attempt: `POST {PROVIDER_URL}/notifications` with exactly the three legacy fields and a 3 second timeout.
   `2xx` stores `provider_record_id`, sets `DELIVERED` and appends the attempt row in one transaction.
5. Provider failure or timeout: the record stays `PENDING`, the attempt row records `PROVIDER_ERROR` /
   `PROVIDER_TIMEOUT`, `next_attempt_at` is scheduled with bounded exponential backoff
   (base `DELIVERY_BACKOFF_BASE_MS`, factor 2, cap 30 s) and the caller gets `502`.
6. Retries (the delivery worker, and any dispatch of an already existing `PENDING` record) first call
   `GET {PROVIDER_URL}/notifications` and skip the `POST` when the provider already holds this `orderId` with
   `type === 'ORDER_CONFIRMATION'`: the record is marked `DELIVERED` with the provider's id and the attempt outcome
   is `RECONCILED`. This closes the ambiguous-failure window, in which the provider accepted a message but the
   response was lost. If the inspection endpoint is unreachable, the retry is rescheduled instead of posting
   blindly.
7. Every delivery attempt of one logical notification is serialized (per-`(type, order_id)` PostgreSQL advisory
   lock), so concurrent dispatches and worker passes can never produce two provider calls, and `attempts` always
   equals the number of attempt rows.
8. `DELIVERY_MAX_ATTEMPTS` caps the worker (default `0` = unlimited with capped backoff, so a required
   notification is never dropped).

## Implementation notes (deliberate decisions)

- The `PENDING` record is committed in its own local transaction **before** the provider is called, so a crash
  between the two can only ever leave a durable `PENDING` record that the worker reconciles. The attempt row is
  written with the outcome in the same transaction as the `DELIVERED` / failure update, because
  `notification_attempts.outcome` is `NOT NULL` with a closed value set in the authoritative schema - the outcome
  simply does not exist before the provider replied.
- Every delivery of one logical notification is serialized with a per-`(type, order_id)` PostgreSQL advisory lock
  (key derived from the notification identity, released automatically if the process dies), so concurrent
  dispatches, worker passes and multiple replicas cannot produce two provider calls.
- Notification ids are allocated from the sequence the authoritative schema already defines
  (`notification_attempts_id_seq`), so no extra DDL is needed outside `schema/notifications-schema.sql`.
- `attempts` always equals the number of `notification_attempts` rows; a replay of an already `DELIVERED`
  notification neither increments it nor writes an attempt row.

## Configuration

Copy `.env.example` (all local defaults, no secrets) and export the variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3004` | HTTP port. |
| `NOTIFICATIONS_DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/notifications` | The only database this service owns. |
| `PROVIDER_URL` | `http://localhost:4010` | External notification provider emulator. |
| `PROVIDER_TIMEOUT_MS` | `3000` | Legacy delivery timeout. |
| `DELIVERY_INTERVAL_MS` | `1000` | Worker pass interval. |
| `DELIVERY_BACKOFF_BASE_MS` | `250` | Exponential backoff base. |
| `DELIVERY_MAX_ATTEMPTS` | `0` | `0` = unlimited retries. |
| `DELIVERY_WORKER_ENABLED` | `true` | `false` disables the worker loop (unit tests never sleep). |

## Local checks

```sh
npm ci                 # install the pinned dependency tree from package-lock.json
npm run build          # tsc -> dist/
npm test               # tsx --test: unit (NOTIF-U*) + integration (NOTIF-I*)
npm run typecheck      # type-checks the test sources too
npm start              # node dist/main.js
```

Integration tests need a real PostgreSQL 17 and use the provider stub that mirrors the unchanged emulator
contract. The harness resolves a database in this order: an isolated database created from
`NOTIFICATIONS_DATABASE_URL`, else a `postgres:17-alpine` container on a free local port, else the local default
server; when none is available the suite fails with the reason instead of skipping. Tests truncate the tables they
own, so point `NOTIFICATIONS_DATABASE_URL` at a disposable notifications database.

Smoke checks:

```sh
curl -s http://localhost:3004/health
curl -s -X POST http://localhost:3004/notifications/order-confirmations \
  -H 'content-type: application/json' -H 'idempotency-key: ORDER_CONFIRMATION:demo-1' \
  -d '{"type":"ORDER_CONFIRMATION","orderId":"demo-1","customerEmail":"buyer@example.com"}'
curl -s http://localhost:3004/notifications
curl -s http://localhost:4010/notifications   # provider-side view of the same delivery
```

## Docker

```sh
docker build -t shopflow-notifications:local .
docker run --rm -p 3004:3004 \
  -e NOTIFICATIONS_DATABASE_URL=postgresql://postgres:postgres@host.docker.internal:5432/notifications \
  -e PROVIDER_URL=http://host.docker.internal:4010 shopflow-notifications:local
```

Multi-stage `node:22-alpine`, exposes `3004`, runs as the non-root `node` user, contains no secrets.
