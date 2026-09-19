# ShopFlow Web

React and TypeScript presentation tier. It talks only to `shopflow-gateway`, always through the same-origin `/api`
prefix (`/api/health`, `/api/products`, `/api/orders`, `/api/orders/:id`, `/api/admin/orders/:id/ship`). The browser
never addresses `shopflow-orders`, `shopflow-inventory` or `shopflow-notifications` directly: in production the nginx
in this image and in development the Vite dev server strip `/api` and forward the request to the gateway, which owns
the routing. The tier has no persistence access.

## Local checks

```sh
npm ci
npm test
npm run build
```

Start the complete system from `../shopflow-infra`, then open <http://localhost:3000>.
