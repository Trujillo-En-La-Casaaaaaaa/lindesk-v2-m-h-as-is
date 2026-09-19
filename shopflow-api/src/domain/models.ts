export type OrderStatus = "CONFIRMED" | "SHIPPED";

export interface Product {
  id: string;
  sku: string;
  name: string;
  priceCents: number;
  stock: number;
}

export interface Order {
  id: string;
  customerEmail: string;
  status: OrderStatus;
  productId: string;
  quantity: number;
  totalCents: number;
  createdAt: string;
}

export interface OrderConfirmation {
  type: "ORDER_CONFIRMATION";
  orderId: string;
  customerEmail: string;
}

export class DomainError extends Error {
  constructor(message: string, readonly code: "INVALID" | "NOT_FOUND" | "INSUFFICIENT_STOCK" | "INVALID_STATUS") {
    super(message);
  }
}
