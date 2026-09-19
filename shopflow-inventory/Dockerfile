# ShopFlow inventory service (owner: shopflow-inventory)
#
# Multi-stage build: the dependencies and the TypeScript sources are only present in the builder, the
# runtime image carries the compiled output and the production dependency tree. No secret and no
# credential is baked into the image; the runtime configuration is injected through the environment
# (`PORT` and the service's own `INVENTORY_DATABASE_URL`, see `.env.example`).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS production
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 3003
USER node
CMD ["node", "dist/main.js"]
