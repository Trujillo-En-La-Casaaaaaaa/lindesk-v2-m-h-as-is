import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { DomainError } from "../../domain/models.js";
import type { ShopService } from "../../application/shopService.js";

export function createApp(service: ShopService) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/products", async (_req, res, next) => {
    try { res.json(await service.listProducts()); } catch (error) { next(error); }
  });
  app.post("/orders", async (req, res, next) => {
    try {
      const order = await service.createOrder({
        productId: String(req.body.productId ?? ""),
        quantity: Number(req.body.quantity),
        customerEmail: String(req.body.customerEmail ?? "")
      });
      res.status(201).json(order);
    } catch (error) { next(error); }
  });
  app.get("/orders/:id", async (req, res, next) => {
    try { res.json(await service.getOrder(req.params.id)); } catch (error) { next(error); }
  });
  app.post("/admin/orders/:id/ship", async (req, res, next) => {
    try { res.json(await service.shipOrder(req.params.id)); } catch (error) { next(error); }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof DomainError) {
      const status = error.code === "NOT_FOUND" ? 404 : error.code === "INVALID_STATUS" ? 409 : 400;
      res.status(status).json({ error: error.message, code: error.code });
      return;
    }
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  });
  return app;
}
