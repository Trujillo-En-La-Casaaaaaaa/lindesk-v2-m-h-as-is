# Verification suites (owner: shopflow-infra)

Two suites live here, both written with Node built-ins only (`node:test`, `node:assert/strict`, global
`fetch`, `node:child_process`). There is no npm dependency and no test framework.

| Suite | File | Needs | Purpose |
| --- | --- | --- | --- |
| Behaviour preservation (P1-P10) | `tests/behavior-preservation.test.js` | the composed stack (`docker compose`) | black-box proof that the migrated runtime preserves the externally observable behaviour of the retired monolith |
| Ownership guards (G1-G7) | `tests/ownership/ownership-guards.test.js` | nothing (static analysis) | architecture fitness functions: one writer per datum, no cross-service database access, no shared persistence shortcut, no gateway domain logic, exactly six repositories, no new public capability |

## Commands

```sh
npm test                  # node --test tests/            both suites
npm run test:preservation # node --test tests/behavior-preservation.test.js
npm run test:guards       # node --test tests/ownership/  guards only, no stack needed
docker compose config     # npm run compose:config
docker compose up --build -d && docker compose down -v   # npm run up / npm run down
```

`tests/index.js` and `tests/ownership/index.js` are suite entry points. They exist because on
Node.js 22+ a positional argument to the test runner is executed as a test file instead of being
searched recursively, so the documented directory form (`node --test tests/`,
`node --test tests/ownership/`) resolves to those modules, which import the suites. A single file
path (`node --test tests/behavior-preservation.test.js`) works directly.

Suite configuration (all optional, see the root `.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:3001` | public API (the legacy monolith and the gateway both use host port 3001) |
| `PROVIDER_URL` | `http://localhost:4010` | provider inspection |
| `COMPOSE_FILE` | `docker-compose.yml` | compose file used for the `up`/`down`/`stop`/`start` steps |
| `RECOVERY_TIMEOUT_MS` | `20000` | upper bound while waiting for background recovery/retry |
| `STARTUP_TIMEOUT_MS` | `240000` | upper bound while waiting for the healthchecks |

The preservation suite resets the stack from clean volumes (`down -v` + `up --build -d`) before the
first scenario and inside P9/P10, so it is re-runnable without manual intervention. It starts and
stops services only through `docker compose stop|start` on `COMPOSE_FILE`, so the tested topology is
the delivered topology.

## Traceability - P1-P10

Each scenario id below is asserted by the subtest of the same name in
`tests/behavior-preservation.test.js` and is reported in the suite's `SCENARIO | STATUS | DETAIL`
table (statuses: `PASS`, `FAIL`, `MIGRATION-ONLY`).

| Id | Assertion | Result at delivery time |
| --- | --- | --- |
| P1 | `GET /products` -> `200 application/json`, exactly the two seeded products ordered by `id`, no extra field | blocked: the stack cannot start |
| P2 | `POST /orders` -> `201 CONFIRMED` with `totalCents 3600`, `GET /orders/:id` identical, `product-a` stock `7`, exactly one provider record with the three legacy fields | blocked |
| P3 | `400 INSUFFICIENT_STOCK` / `404 NOT_FOUND` / `400 INVALID` with no stock, order-row or provider side effect; the order-row probe runs the migrated `psql -U orders -d orders` variant and records which variant ran | blocked |
| P4 | `GET /orders/:id` -> `200 CONFIRMED`; unknown id -> `404 NOT_FOUND` | blocked |
| P5 | `POST /admin/orders/:id/ship` -> `200 SHIPPED` and persisted; repeat -> `409 INVALID_STATUS`; unknown id -> `404`; no stock or provider effect | blocked |
| P6 | provider stopped -> `POST /orders` `500 Internal server error` with the order committed and stock decremented; after the provider restarts exactly one confirmation is delivered within `RECOVERY_TIMEOUT_MS`; documented deviation vs the legacy stack (which loses it) recorded | blocked |
| P6 implementation note | The `500` body carries no order id, so the scenario takes the id from the confirmation the durable outbox delivers once the provider returns (which is itself the proof that the order survived) and asserts the order detail and the stock decrement against it; the stock assertion is additionally made immediately, before the wait. The provider keeps its records in provider-process memory (verified live: `docker compose stop` + `start` returns an empty `GET /notifications`), so the scenario accepts **either** a preserved **or** a reset inspection list and keys every assertion on the order id; correspondingly, the legacy branch asserts that the record count does not *grow* rather than that it is unchanged. | - |
| P7 | `POST /orders/:id/cancel` and `DELETE /orders/:id` -> `404`, status and stock unchanged | blocked |
| P8 | repeated `POST /orders` with the same `Idempotency-Key` -> `200` + `x-idempotent-replay: true`, one order, one decrement, exactly one confirmation; the legacy deviation (header unsupported) is recorded | blocked |
| P9 | ambiguous decrement (`503 UNAVAILABLE`), mid-saga crash, recovery to `COMPLETED`, stock exactly `6`, one order row, one confirmation, idempotent second restart - **migration-only** (see below) | MIGRATION-ONLY on the legacy topology; blocked on the migrated stack |
| P10 | `docker compose config` without warnings or retired references; `up --build -d` healthy with exactly the nine services; `down -v` + `up` restores `product-a` 10, `product-b` 5, empty order and notification tables | blocked |

Migration-only scenarios: P9 cannot be produced on the legacy topology (a single `api` monolith over
one shared `db`, no individually restartable services), and P6/P8 contain an explicitly recorded
legacy deviation. None of them is skipped: the suite reports `MIGRATION-ONLY` with the reason, and the
legacy comparison is kept in `tests/baseline/README.md`.

## Traceability - G1-G7

| Id | Guard | Where it fails |
| --- | --- | --- |
| G1 | one writer per datum: stock mutation, and the `products`, `orders` and `notifications` tables, only in the owning repository (plus the composition repository's `postgres/*-init.sql`) | `G1 FAIL <repo>/<file>:<line> matches <pattern>` |
| G2 | every `DATABASE_URL` in a service repository is that service's own name; no repository outside this one names a foreign database host; the retired names (`shopflow-api`, `postgres-db`, the shared `shopflow` connection string) appear nowhere | same format |
| G3 | the compose file declares exactly the nine services; `orders`, `inventory` and `notifications` each receive exactly one `*_DATABASE_URL` naming their own database; the gateway and the UI receive none; no database service publishes a host port; each database owns one volume and one init script and no init script is mounted twice; every dependency edge is `condition: service_healthy`; the startup-ordering edge set is exactly the documented one (`inventory-db`->`inventory`; `notifications-db`+`notification-emulator`->`notifications`; `orders-db`+`inventory`->`orders`; `orders`+`inventory`->`gateway`; `gateway`->`web`) and the databases and the provider declare no `depends_on` at all; published host ports are exactly 3000, 3001 and 4010 by the documented services | same format |
| G4 | no sibling source import in `shopflow-gateway`, `shopflow-web`, `shopflow-notifications`, `shopflow-orders`; each table defined by exactly one owner repository; no `stock` column outside `shopflow-inventory`; the three `postgres/*-init.sql` copies are byte-identical to the owning repository's DDL | same format |
| G5 | `shopflow-gateway` has no database driver dependency, no `DATABASE_URL`, no SQL text, no order-state or stock-error literal, no stock mutation or price computation, and declares exactly the five public routes | same format |
| G6 | exactly the six expected repositories as siblings (repository root = `package.json`, `docker-compose.yml` or `.git`), and the retired `shopflow-api` absent; the repository listing it used is printed as `G6 LISTING ...` | same format |
| G7 | the public route set from the gateway route table and the edge registration equals the five documented routes; no cancel/refund/search/auth route; host port 3001 is published by the gateway only; the additive behaviour is the `Idempotency-Key` header and the `503 UNAVAILABLE` envelope; the edge invents no other status code | same format |

Guard statuses: G1-G5 and G7 pass; **G6 fails at delivery time** because four sibling repositories are
still missing (`shopflow-web` empty, `shopflow-orders`, `shopflow-inventory`, `shopflow-notifications`
holding only their handoff folders). G6 is designed to fail in exactly that situation.

## Guard scan scope

The guards read the six sibling repositories as text and deployment configuration. Besides the
specified ignore list (`node_modules`, `dist`, `build`, `.git`, `coverage`, lockfiles) the walker
skips, with the reason stated in the source:

- `.handoff/` - the handoff input folder, not part of a delivered repository tree (untracked in git);
- `tests/` - verification assets. The preservation spec requires the black-box suite to count order
  rows through `psql` (P3 step 6) and to record the retired legacy commands, so verification assets
  are not production data-access code;
- Markdown in this repository - documentation cannot write to a database (G2 still scans the
  documentation of the five service repositories, which is where a retired name would be a real leak).

Each guard's detail line reports how many repositories and files it actually scanned, so a vacuous
pass cannot be mistaken for proof.

## Evidence produced by these suites

- `tests/baseline/legacy-baseline.txt` and `tests/baseline/README.md` - the required legacy baseline
  (commands, per-scenario result, reasons, and the migration-only scenarios).
- `tests/baseline/legacy-suite-run.txt`, `tests/baseline/migrated-suite-run.txt` - raw suite output on
  the legacy topology and on the delivered definition.
- Provider inspection payloads for P2, P6, P8 and P9 are printed as diagnostics (`P2 GET
  http://localhost:4010/notifications -> [...]`) and appear in the captured run output.
- The `G6 LISTING` lines are the repository listing guard G6 used.
- `tests/baseline/runtime-probe-evidence.txt` - the runtime probe of the three database services
  (health, isolation, init scripts, seed, `down -v` reset semantics, no published host port) and of
  the unchanged provider emulator contract. It is what an end-to-end run cannot show yet, because the
  application services cannot be built in this workspace.
- `tests/baseline/gateway-probe-evidence.txt` - the isolated runtime probe of the one implemented
  application service: `GET /health`, the documented `503 UNAVAILABLE` envelope on every proxied route,
  the absent cancellation routes, `cors()` and the compose healthcheck command running inside the
  container.

Host caveat for the `docker compose` steps: on Docker Desktop for Windows, bind mounts whose source
path is long are served to a non-root container user with `I/O error`, so the postgres entrypoint
exits 1 before applying its init script. This workspace path is affected (reproduced with a three-line
unrelated compose project); the same delivered files work from a short path. See
`tests/baseline/runtime-probe-evidence.txt` for the reproductions.
