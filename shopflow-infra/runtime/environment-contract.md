# Environment contract for the migrated ShopFlow runtime

Owner: `shopflow-infra`. This is the delivered copy of the contract that `docker-compose.yml`
implements: every variable each service receives, the per-database credential scheme and the
cross-service access rule that ownership guard G3 enforces.

Rules: no secret values are committed anywhere. The databases use local throwaway credentials
fixed by the fixture (the same style as the legacy `POSTGRES_USER/POSTGRES_PASSWORD: shopflow`)
and every variable below is documented in the owning repository's `.env.example` with a
placeholder-free local default. The root `.env.example` mirrors the compose-level values.

## Service variables (injected by `docker-compose.yml`)

### `gateway` (shopflow-gateway)

| Variable | Value | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | public API port |
| `ORDERS_URL` | `http://orders:3002` | orders service base URL |
| `INVENTORY_URL` | `http://inventory:3003` | inventory service base URL |
| `UPSTREAM_TIMEOUT_MS` | `5000` | upstream timeout |

No database variable exists in this service by design (ADR-0007, guard G5). The gateway owns no datum
and exposes no persistence.

### `orders` (shopflow-orders)

| Variable | Value | Purpose |
| --- | --- | --- |
| `PORT` | `3002` | service port |
| `ORDERS_DATABASE_URL` | `postgres://orders:orders@orders-db:5432/orders` | the only database this service may use |
| `INVENTORY_URL` | `http://inventory:3003` | inventory service base URL |
| `NOTIFICATIONS_URL` | `http://notifications:3004` | notifications service base URL |
| `SAGA_INTERVAL_MS` | `1000` | recovery worker period (tests lower/disable it) |
| `OUTBOX_INTERVAL_MS` | `1000` | outbox dispatcher period (tests lower/disable it) |
| `OUTBOX_BACKOFF_BASE_MS` | `250` | retry backoff base |
| `INLINE_CALL_ATTEMPTS` | `2` | inline attempts before returning 503 `UNAVAILABLE` |
| `UPSTREAM_TIMEOUT_MS` | `3000` | inventory/notifications call timeout |

### `inventory` (shopflow-inventory)

| Variable | Value | Purpose |
| --- | --- | --- |
| `PORT` | `3003` | service port |
| `INVENTORY_DATABASE_URL` | `postgres://inventory:inventory@inventory-db:5432/inventory` | the only database this service may use |

### `notifications` (shopflow-notifications)

| Variable | Value | Purpose |
| --- | --- | --- |
| `PORT` | `3004` | service port |
| `NOTIFICATIONS_DATABASE_URL` | `postgres://notifications:notifications@notifications-db:5432/notifications` | the only database this service may use |
| `PROVIDER_URL` | `http://notification-emulator:4010` | external provider base URL |
| `PROVIDER_TIMEOUT_MS` | `3000` | preserved legacy provider timeout |
| `DELIVERY_INTERVAL_MS` | `1000` | delivery worker period (tests lower/disable it) |
| `DELIVERY_BACKOFF_BASE_MS` | `250` | retry backoff base |
| `DELIVERY_MAX_ATTEMPTS` | `0` | `0` = unlimited attempts with capped backoff |

### `notification-emulator` (external provider stand-in, unchanged)

| Variable | Value | Purpose |
| --- | --- | --- |
| `PORT` | `4010` | provider port, host-published for inspection |

### `web` (shopflow-web)

No runtime variables. The SPA is static; `/api` proxying is configured in `nginx.conf`
(`http://gateway:3001/`). Host port `3000` is preserved from the legacy deployment.

## Database variables (infra-owned)

Each database container gets its own database, user and password, all local fixture values, plus its own
volume and its own init script. The init scripts are the applied copies of the owning repositories'
authoritative schema files:

| Database service | `POSTGRES_DB` | `POSTGRES_USER` | `POSTGRES_PASSWORD` | Volume | Init script |
| --- | --- | --- | --- | --- | --- |
| `orders-db` | `orders` | `orders` | `orders` | `orders-data` | `postgres/orders-init.sql` |
| `inventory-db` | `inventory` | `inventory` | `inventory` | `inventory-data` | `postgres/inventory-init.sql` |
| `notifications-db` | `notifications` | `notifications` | `notifications` | `notifications-data` | `postgres/notifications-init.sql` |

These are development-only defaults for an offline fixture. They are not production secrets, and no real
credential, token, API key or certificate may be added to any repository; production deployments inject real
values through the environment.

## Cross-service access rule (testable)

For every application service, the set of `*_DATABASE_URL` variables it can see must contain exactly one entry, and
that entry must name its own database. The gateway sees none. Guard G3 in `tests/ownership/` fails otherwise, and
the mount rule below makes a shared database impossible at the topology level:

- `orders-db` mounts only `postgres/orders-init.sql`; `inventory-db` only `postgres/inventory-init.sql`;
  `notifications-db` only `postgres/notifications-init.sql`. No init script is mounted into more than one
  container, so the deleted shared `postgres/init.sql` has no successor as a shared schema authority.
- No database service publishes a host port: only `3000` (web), `3001` (gateway) and `4010`
  (notification-emulator) are reachable from the host.

## Startup ordering (healthcheck-gated)

`inventory-db` -> `inventory`; `notifications-db` + `notification-emulator` -> `notifications`;
`orders-db` + `inventory` -> `orders`; `orders` + `inventory` -> `gateway`; `gateway` -> `web`.

Every one of those edges is a `depends_on` entry with `condition: service_healthy`, so no service starts before
the dependency it needs is actually ready. Guard G3 asserts the edges and the healthchecks.
