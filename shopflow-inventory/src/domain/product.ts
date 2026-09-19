/**
 * The product catalog value object owned by this service.
 *
 * Field names, types and semantics are identical to the legacy `GET /products` response, so the
 * gateway can pass the body through unchanged. Money is an integer number of cents.
 */
export interface Product {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly priceCents: number;
  readonly stock: number;
}
