# ShopFlow API

Node.js and TypeScript HTTP API using Hexagonal Architecture.

- `src/domain`: framework-independent entities and rules.
- `src/application`: use cases.
- `src/ports`: interfaces owned by the core.
- `src/adapters`: Express, PostgreSQL, and notification provider implementations.

## Local checks

```sh
npm ci
npm test
npm run build
```

The complete system is started from `../shopflow-infra`. API routes are `GET /products`, `POST /orders`, `GET /orders/:id`, and `POST /admin/orders/:id/ship`. Cancellation is intentionally unsupported.
