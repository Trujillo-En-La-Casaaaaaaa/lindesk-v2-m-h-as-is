# Legacy baseline (Step 0) - record

This folder holds the Step 0 evidence required by the handoff: the black-box preservation suite is
run once against the **legacy** stack, before this repository is restructured, so that preservation
is demonstrated and not merely asserted.

## Legacy sources used (unmodified)

| Item | Value |
| --- | --- |
| Repository | this repository, commit `e49c18d` "Freeze F2 ShopFlow infrastructure fixture" (the frozen As-Is fixture) |
| Legacy compose file | `docker-compose.yml` at that commit: services `db`, `notifications`, `api`, `web` |
| Legacy database provisioning | `postgres/init.sql` at that commit: shared `products` + `orders` schema and the deterministic seed |
| Legacy application build contexts | `../shopflow-api` and `../shopflow-web` (referenced by the legacy compose file) |
| Provider emulator | `notification-emulator/` (byte-identical before and after the migration) |

The As-Is repositories were not modified, and nothing was deleted from this repository before the
capture.

## Commands

All commands were run from this repository.

```sh
# 1. legacy stack, before any file of this repository was changed
docker compose config          > tests/baseline/legacy-compose-config.txt 2>&1
docker compose up --build -d   > tests/baseline/legacy-up-build.txt       2>&1
docker compose ps -a           > tests/baseline/legacy-ps.txt             2>&1
docker compose down -v         > tests/baseline/legacy-down.txt           2>&1

# 2. suite run against the legacy topology (the legacy compose definition restored from the fixture
#    commit into a temporary file so that the delivered file stays the migrated one)
git show HEAD:docker-compose.yml > docker-compose.legacy.yml
set COMPOSE_FILE=docker-compose.legacy.yml
node --test tests/behavior-preservation.test.js > tests/baseline/legacy-suite-run.txt 2>&1
del docker-compose.legacy.yml
```

The handoff's own Step 0 line is `docker compose up --build -d && node --test tests/ > tests/baseline/legacy-baseline.txt 2>&1; docker compose down -v`.
Because `docker compose up --build -d` fails (see below), the `&&` short-circuits and that command
would have written an empty file. The suite was therefore executed explicitly in step 2 so that the
per-scenario table below is a real measurement of the suite against the legacy topology.

## Outcome: the legacy stack cannot be started in this workspace

```
$ docker compose up --build -d
#1 [internal] load local bake definitions
#1 reading from stdin 1.86kB 0.0s done
#1 DONE 0.0s
unable to prepare context: path "...\workspaces\shopflow-api" not found
```

The legacy compose file builds the retired `../shopflow-api` repository from a sibling directory
that does not exist in this workspace, and `../shopflow-web`, which exists only as an empty
directory (no Dockerfile). Consequently:

- `docker compose up --build -d` exits non-zero and no container is ever created
  (`docker compose ps -a` shows an empty table),
- no legacy process ever listens on `3001`, `3000` or `4010`,
- **no scenario can be measured against the legacy stack**: the suite blocks at its setup step for
  every scenario with the shared reason
  `unable to prepare context: path "...\workspaces\shopflow-api" not found`.

`docker compose config` does render the legacy definition without warnings (it only resolves the
file, not the build contexts); that render is kept in `legacy-compose-config.txt` as the record of
the As-Is topology: services `db`, `notifications`, `api`, `web`, one shared `shopflow-data` volume,
one shared `postgres/init.sql`, and `DATABASE_URL: postgres://shopflow:shopflow@db:5432/shopflow`.

## Per-scenario result on the legacy stack

`COMPOSE_FILE=docker-compose.legacy.yml node --test tests/behavior-preservation.test.js`
(target detection reported `stack target: legacy`, `compose services: db, notifications, api, web`):

| Scenario | Result | Reason |
| --- | --- | --- |
| P1 product catalog | NOT RUN (blocked) | legacy stack cannot be started: `../shopflow-api` build context missing |
| P2 order creation end to end | NOT RUN (blocked) | same |
| P3 inventory validation and no-op rejection | NOT RUN (blocked) | same |
| P4 order detail and status | NOT RUN (blocked) | same |
| P5 administrative transition to SHIPPED | NOT RUN (blocked) | same |
| P6 provider failure while the order survives | NOT RUN (blocked) | same; on the legacy stack the scenario would stop the `notifications` service and record the documented deviation (the legacy system loses the confirmation) |
| P7 no customer cancellation | NOT RUN (blocked) | same |
| P8 confirmation delivered once despite duplicate dispatches | NOT RUN (blocked) | same; on the legacy stack the `Idempotency-Key` header is not supported, which the scenario records as a deviation |
| P9 ambiguous failure, restart and stock exactness | **MIGRATION-ONLY** | needs individually restartable `inventory` and `orders` services plus a separate `inventory-db`; the legacy topology is a single `api` monolith over one shared `db`, so an ambiguous decrement outcome and a mid-saga crash cannot be produced there |
| P10 composed runtime readiness | NOT RUN (blocked) | same as P1 |

Suite totals on the legacy topology: `0 PASSED | 9 FAILED | 1 MIGRATION-ONLY | 10 SCENARIOS`, where
every FAIL is the same setup-level blocker and not a behavioural regression.

## Traceability of the scenarios that cannot run

Both exception classes above are recorded, never silently skipped:

- **P9 is migration-only**: it is referenced by the traceability matrix in `tests/README.md` and its
  outcome is reported as `MIGRATION-ONLY` in the suite table, with the reason, on both stacks.
- **Every blocked scenario** keeps its assertions and fails loudly with the exact compose error; the
  suite never converts a failed start into a pass or a skip.

## Files in this folder

| File | Content |
| --- | --- |
| `legacy-baseline.txt` | assembled Step 0 record: the raw pre-edit capture (config, up, ps, down) plus the raw suite run against the legacy topology |
| `legacy-compose-config.txt` | raw `docker compose config` render of the legacy compose file (pre-edit) |
| `legacy-up-build.txt` | raw `docker compose up --build -d` failure of the legacy stack (pre-edit) |
| `legacy-ps.txt` | raw `docker compose ps -a` of the legacy stack (pre-edit, empty table) |
| `legacy-down.txt` | raw `docker compose down -v` of the legacy stack (pre-edit) |
| `legacy-suite-run.txt` | raw suite output against the legacy topology |
| `migrated-suite-run.txt` | raw suite output against the delivered migrated definition, captured at delivery time (see below) |
| `runtime-probe-evidence.txt` | runtime probe of the three database services and the provider emulator - what it proves, how it was run, and its raw output (see below) |
| `gateway-probe-evidence.txt` | runtime probe of the only implemented application service (`gateway`): liveness, the `503` envelope on every proxied route, the prohibited routes and the Node healthcheck form, with its raw output |

## Runtime probe evidence - what is already verified with real containers

The nine-service stack cannot run yet (see the next section), but three of its services and the
provider emulator have no dependency on the missing repositories. They were started and probed
directly; the raw output is in `runtime-probe-evidence.txt`.

| Check | Result |
| --- | --- |
| `orders-db`, `inventory-db`, `notifications-db` reach `healthy` (own image, own credentials, own volume, own init script) | **verified**: `"Health":"healthy"`, `ExitCode: 0` for all three |
| No database service publishes a host port (criterion 6, host half) | **verified**: `Publishers[].PublishedPort = 0`, `docker compose port <db> 5432` -> not published, `PORTS` = `5432/tcp` |
| One writer per datum at the data level | **verified**: orders-db holds only `orders`, `order_operations`, `notification_outbox`; inventory-db only `products`, `stock_decrements`; notifications-db only `notifications`, `notification_attempts` - no cross-owner table exists in any database |
| Deterministic seed applied from `postgres/inventory-init.sql` (criterion 3, seed half) | **verified**: `product-a` 1200/stock 10, `product-b` 2500/stock 5; orders and notifications tables empty |
| `down -v` + `up -d` restores the exact seed after data mutation (criterion 3, reset half) | **verified**: mutated to stock 3 + 1 order row + 1 notification row -> after reset stock 10/5 and both tables empty, all three services healthy |
| An initialised database is **not** re-seeded by a restart (the invariant P9's idempotent restart and the reset semantics rely on) | **verified live**: mutated to stock 3 + 1 order row -> `docker compose stop inventory-db orders-db` -> `docker compose start inventory-db orders-db` -> still stock 3, still 1 order row, all three services healthy (the init scripts run only when a volume is created) |
| Provider emulator serves its unchanged contract on host port 4010 | **verified**: `GET /health` 200 `{"ok":true}`; valid `POST /notifications` -> 201 `notification-0001` echoing exactly the three legacy fields; wrong type and missing `orderId` -> 400 `{"error":"Invalid notification"}`; `GET /notifications` returns the stored record. Re-verified **in the delivered project** (`docker compose up -d --build notification-emulator` from the repository root): `Up (healthy)`, `0.0.0.0:4010->4010/tcp`, the compose healthcheck command exits 0 inside the container, and the handoff's inspection command `curl -i http://localhost:4010/notifications` returns `HTTP/1.0 200 OK` with the record |
| Provider stop/start semantics (used by P6 and by criterion 8) | **verified live in the delivered project**: `docker compose stop notification-emulator` -> `Exited (137)` and `curl` reports HTTP code `000` (exactly the outage the scenario needs); `docker compose start` -> `Up (healthy)` and `0.0.0.0:4010->4010/tcp`. The record list is **not** preserved across the restart (`GET /notifications` -> `[]`), which is consistent with the provider contract and which exposed and led to the fix of a defect in the first P6 implementation |
| `web` healthcheck command (the only service definition that could not be run at all) | **verified against both official nginx bases** in a live container: `nginx:alpine` has `wget` and `curl`, `nginx:latest` (debian) has `curl` but no `wget`, and the dual check exits 0 on both |
| `runtime/compose-plan.md` conformance (build contexts, images, published ports, volumes, init-script mount targets, healthcheck cadence and healthcheck test commands) | **verified**: field-by-field comparison of `docker compose config --format json` against the plan's table - 54/54 checks match, including "no published port" for the six internal services and the exact `/docker-entrypoint-initdb.d/001-<name>-init.sql` targets |
| `gateway` liveness and failure surface (isolated probe, `gateway-probe-evidence.txt`) | **verified**: image builds from the compose context and publishes `3001:3001`; `GET /health` -> 200 `{"ok":true}` with a generated `x-correlation-id` **while both upstreams are unreachable**; `GET /products`, `POST /orders`, `GET /orders/:id`, `POST /admin/orders/:id/ship` -> the documented `503 {"error":"Upstream service unavailable","code":"UNAVAILABLE"}` (the ship route proves the `/admin/.../ship` -> `/orders/:id/ship` rewrite is proxied); `POST /orders/:id/cancel` and `DELETE /orders/:id` -> `404 {"error":"Not found","code":"NOT_FOUND"}`; `Access-Control-Allow-Origin: *`; the compose healthcheck command exits 0 inside the container |
| Domain success paths on 3001, the `web`/`orders`/`inventory`/`notifications` images, P1-P10, criteria 2/3 (application half), 7's domain responses and 8 | **not verified**: those build contexts are missing (next section); everything the gateway can show without them is verified in the row above |

The probe had to run from a short directory path (a byte-identical copy of `docker-compose.yml`,
`postgres/*-init.sql` and `notification-emulator/`) because of an environment defect that was
reproduced with a three-line unrelated compose project:

- on Docker Desktop for Windows, a bind mount whose **source path is long** (this workspace path,
  and a synthetic ~130-character path) is served to a non-root container user with
  `I/O error`, so the postgres 17 entrypoint's own `ls /docker-entrypoint-initdb.d/` guard fails and
  the container exits 1;
- the identical compose structure, file bytes and target path succeed at a short path
  (`C:\Users\SEBRH\...`, `%TEMP%\...`).

So `docker compose up --build -d` from this workspace directory cannot start any database container
no matter how the compose file is written, while the same delivered file works unchanged from a
short path. This is a property of the host environment, not of the delivered artifact.

## Migrated stack snapshot - why the P* scenarios are not green yet

`migrated-suite-run.txt` is the run against the delivered `docker-compose.yml`. At delivery time the
stack could not reach a healthy state because the Wave 1-3 sibling repositories are still missing
from the workspace, and the compose build contexts legitimately point at them:

```
target web: failed to solve: failed to read dockerfile: open Dockerfile: no such file or directory
```

`../shopflow-web` is an empty directory; `../shopflow-orders`, `../shopflow-inventory` and
`../shopflow-notifications` contain only their handoff folders; `../shopflow-gateway` is implemented
and builds. This is the blocker reported by ownership guard G6 (it fails exactly when a sibling
repository is missing) and it is the reason acceptance criteria 2, 3 (application half), 4, 7 and 8
cannot be evidenced yet.

A second, host-level blocker applies on top of it: from a directory path as long as this workspace,
Docker Desktop for Windows cannot serve bind-mounted files to a non-root container user
(`I/O error`), so the postgres entrypoint exits 1 before it applies the init script. Database
provisioning, the seed and the provider contract are therefore proven from a short path in
`runtime-probe-evidence.txt`. When both blockers are gone, regenerate this snapshot:

- `docker compose up --build -d` run from a short path must reach a healthy steady state with the
  nine services (from this workspace path the three database containers will exit 1 on this host),
- `node --test tests/` must report `10 PASSED | 0 FAILED | 0 MIGRATION-ONLY`,
- `node --test tests/ownership/` must report `TOTAL | 7/7 PASSED`.

Operational note for whoever re-runs the build: the four application images and the provider image pull
their base images from Docker Hub, and the Node images run `npm ci` against the npm registry (the
gateway's Dockerfile also resolves the `docker/dockerfile:1` syntax frontend). During the probes one
transient Hub error was observed while resolving that frontend
(`failed to authorize: Unavailable: error reading from server: EOF`); it did not affect the delivered
artifact - the build succeeded when repeated - and it is not a defect of this repository. Re-run
`docker compose up --build -d` if the registry is briefly unavailable.
