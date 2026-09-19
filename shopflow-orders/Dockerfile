# ShopFlow orders service (owner: shopflow-orders)
#
# Multi-stage build: the TypeScript compiler and the dev dependencies stay in the builder, the runtime
# image carries the compiled output and the production dependency tree. No secret and no credential is
# baked into the image; the runtime configuration is injected through the environment (`PORT`,
# `ORDERS_DATABASE_URL`, `INVENTORY_URL`, `NOTIFICATIONS_URL` and the worker settings - see
# `.env.example`).
#
# The schema (`schema/orders-schema.sql`) is applied by `shopflow-infra` as
# `postgres/orders-init.sql`, so this image does not migrate anything at start.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS production
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 3002
USER node
CMD ["node", "dist/main.js"]
