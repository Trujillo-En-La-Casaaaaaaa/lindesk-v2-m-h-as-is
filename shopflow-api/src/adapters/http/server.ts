import { randomUUID } from "node:crypto";
import { ShopService } from "../../application/shopService.js";
import { HttpNotificationAdapter } from "../notification/httpNotification.js";
import { createPool, PostgresStore } from "../postgres/postgresStore.js";
import { createApp } from "./app.js";

const store = new PostgresStore(createPool());
const service = new ShopService(
  store.products,
  store.orders,
  store,
  new HttpNotificationAdapter(process.env.NOTIFICATION_URL ?? "http://localhost:4010"),
  { next: randomUUID },
  { now: () => new Date().toISOString() }
);

const port = Number(process.env.PORT ?? 3001);
createApp(service).listen(port, "0.0.0.0", () => console.log(`ShopFlow API listening on ${port}`));
