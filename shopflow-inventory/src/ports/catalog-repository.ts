import type { Product } from '../domain/product.js';

/**
 * Outbound port for the product catalog this service owns.
 *
 * Implemented by `src/adapters/postgres/pg-catalog-repository.ts` over the `products` table.
 */
export interface CatalogRepository {
  /** Every product, ordered by `id` ascending (the legacy `ORDER BY id`). */
  listProducts(): Promise<Product[]>;
  findProductById(productId: string): Promise<Product | null>;
  /**
   * Guarded conditional decrement: `UPDATE products SET stock = stock - quantity
   * WHERE id = productId AND stock >= quantity`.
   *
   * The update is the serialization point against overselling: it reports the remaining stock when
   * exactly one row was updated and `null` when the guard rejected the update.
   */
  decrementStock(productId: string, quantity: number): Promise<number | null>;
}
