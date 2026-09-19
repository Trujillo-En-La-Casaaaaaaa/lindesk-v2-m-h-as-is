# ShopFlow Infrastructure

Docker Compose runs the complete local system: React web, Node API, PostgreSQL, and the deterministic HTTP notification emulator.

## Start

From this repository, run the single command:

```sh
docker compose up --build
```

Open <http://localhost:3000>. The API is also exposed at <http://localhost:3001>, and recorded order confirmations can be inspected at <http://localhost:4010/notifications>.

Deterministic database seeds:

- Product A: ID `product-a`, SKU `SKU-A`, stock `10`
- Product B: ID `product-b`, SKU `SKU-B`, stock `5`

To restore the exact seed state, run `docker compose down -v` before starting again. All services are local; no cloud service or internet connection is used at runtime.
