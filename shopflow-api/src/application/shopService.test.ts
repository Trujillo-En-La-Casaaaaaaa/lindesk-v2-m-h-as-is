import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ShopService } from "./shopService.js";
import type { Order, OrderConfirmation, Product } from "../domain/models.js";
import type { NotificationPort, OrderPort, ProductPort, UnitOfWorkPort } from "../ports/index.js";

class MemoryStore implements UnitOfWorkPort {
  products = new Map<string, Product>([["product-a", { id: "product-a", sku: "SKU-A", name: "Product A", priceCents: 1200, stock: 10 }]]);
  orders = new Map<string, Order>();
  productPort: ProductPort = {
    list: async () => [...this.products.values()],
    getById: async (id) => this.products.get(id) ?? null,
    decrementStock: async (id, quantity) => {
      const product = this.products.get(id);
      if (!product || product.stock < quantity) return false;
      product.stock -= quantity;
      return true;
    }
  };
  orderPort: OrderPort = {
    getById: async (id) => this.orders.get(id) ?? null,
    create: async (order) => { this.orders.set(order.id, order); },
    markShipped: async (id) => {
      const order = this.orders.get(id);
      if (!order || order.status !== "CONFIRMED") return null;
      order.status = "SHIPPED";
      return order;
    }
  };
  execute<T>(work: (products: ProductPort, orders: OrderPort) => Promise<T>) { return work(this.productPort, this.orderPort); }
}

class Notifications implements NotificationPort {
  sent: OrderConfirmation[] = [];
  async sendConfirmation(message: OrderConfirmation) { this.sent.push(message); }
}

function fixture() {
  const store = new MemoryStore();
  const notifications = new Notifications();
  const service = new ShopService(store.productPort, store.orderPort, store, notifications, { next: () => "order-1" }, { now: () => "2026-01-01T00:00:00.000Z" });
  return { service, store, notifications };
}

describe("ShopService", () => {
  it("creates a CONFIRMED order, decrements stock, and sends confirmation", async () => {
    const { service, store, notifications } = fixture();
    const order = await service.createOrder({ productId: "product-a", quantity: 3, customerEmail: "buyer@example.com" });
    assert.equal(order.status, "CONFIRMED");
    assert.equal(order.totalCents, 3600);
    assert.equal(store.products.get("product-a")?.stock, 7);
    assert.deepEqual(notifications.sent, [{ type: "ORDER_CONFIRMATION", orderId: "order-1", customerEmail: "buyer@example.com" }]);
  });

  it("rejects insufficient stock without creating an order or notification", async () => {
    const { service, store, notifications } = fixture();
    await assert.rejects(service.createOrder({ productId: "product-a", quantity: 11, customerEmail: "buyer@example.com" }), /Insufficient stock/);
    assert.equal(store.orders.size, 0);
    assert.equal(notifications.sent.length, 0);
  });

  it("marks a CONFIRMED order SHIPPED and cannot ship it twice", async () => {
    const { service } = fixture();
    await service.createOrder({ productId: "product-a", quantity: 1, customerEmail: "buyer@example.com" });
    assert.equal((await service.shipOrder("order-1")).status, "SHIPPED");
    await assert.rejects(service.shipOrder("order-1"), /Only CONFIRMED/);
  });
});
