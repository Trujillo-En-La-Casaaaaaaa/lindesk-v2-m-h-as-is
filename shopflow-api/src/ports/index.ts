import type { Order, OrderConfirmation, Product } from "../domain/models.js";

export interface ProductPort {
  list(): Promise<Product[]>;
  getById(id: string): Promise<Product | null>;
  decrementStock(id: string, quantity: number): Promise<boolean>;
}

export interface OrderPort {
  getById(id: string): Promise<Order | null>;
  create(order: Order): Promise<void>;
  markShipped(id: string): Promise<Order | null>;
}

export interface UnitOfWorkPort {
  execute<T>(work: (products: ProductPort, orders: OrderPort) => Promise<T>): Promise<T>;
}

export interface NotificationPort {
  sendConfirmation(message: OrderConfirmation): Promise<void>;
}

export interface IdPort {
  next(): string;
}

export interface ClockPort {
  now(): string;
}
