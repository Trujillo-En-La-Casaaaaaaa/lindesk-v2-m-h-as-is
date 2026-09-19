import { DomainError, type Order, type Product } from "../domain/models.js";
import type { ClockPort, IdPort, NotificationPort, OrderPort, ProductPort, UnitOfWorkPort } from "../ports/index.js";

export class ShopService {
  constructor(
    private readonly products: ProductPort,
    private readonly orders: OrderPort,
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly notifications: NotificationPort,
    private readonly ids: IdPort,
    private readonly clock: ClockPort
  ) {}

  listProducts(): Promise<Product[]> {
    return this.products.list();
  }

  async getOrder(id: string): Promise<Order> {
    const order = await this.orders.getById(id);
    if (!order) throw new DomainError("Order not found", "NOT_FOUND");
    return order;
  }

  async createOrder(input: { productId: string; quantity: number; customerEmail: string }): Promise<Order> {
    if (!input.productId || !Number.isInteger(input.quantity) || input.quantity < 1 || !input.customerEmail.includes("@")) {
      throw new DomainError("A product, positive whole quantity, and valid email are required", "INVALID");
    }

    const order = await this.unitOfWork.execute(async (products, orders) => {
      const product = await products.getById(input.productId);
      if (!product) throw new DomainError("Product not found", "NOT_FOUND");
      if (product.stock < input.quantity || !(await products.decrementStock(product.id, input.quantity))) {
        throw new DomainError("Insufficient stock", "INSUFFICIENT_STOCK");
      }
      const created: Order = {
        id: this.ids.next(),
        customerEmail: input.customerEmail,
        status: "CONFIRMED",
        productId: product.id,
        quantity: input.quantity,
        totalCents: product.priceCents * input.quantity,
        createdAt: this.clock.now()
      };
      await orders.create(created);
      return created;
    });

    await this.notifications.sendConfirmation({
      type: "ORDER_CONFIRMATION",
      orderId: order.id,
      customerEmail: order.customerEmail
    });
    return order;
  }

  async shipOrder(id: string): Promise<Order> {
    const current = await this.orders.getById(id);
    if (!current) throw new DomainError("Order not found", "NOT_FOUND");
    if (current.status !== "CONFIRMED") throw new DomainError("Only CONFIRMED orders can be shipped", "INVALID_STATUS");
    const shipped = await this.orders.markShipped(id);
    if (!shipped) throw new DomainError("Order could not be shipped", "INVALID_STATUS");
    return shipped;
  }
}
