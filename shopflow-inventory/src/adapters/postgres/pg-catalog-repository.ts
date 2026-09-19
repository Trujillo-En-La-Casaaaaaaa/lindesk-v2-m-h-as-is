import type { Product } from '../../domain/product.js';
import type { CatalogRepository } from '../../ports/catalog-repository.js';
import type { Queryable } from './queryable.js';

type ProductRow = {
  id: string;
  sku: string;
  name: string;
  price_cents: number;
  stock: number;
};

type StockRow = {
  stock: number;
};

const SELECT_PRODUCT = 'SELECT id, sku, name, price_cents, stock FROM products';

/** The `products` table of the service's own database; this repository is its only writer. */
export class PgCatalogRepository implements CatalogRepository {
  constructor(private readonly database: Queryable) {}

  async listProducts(): Promise<Product[]> {
    const result = await this.database.query<ProductRow>(`${SELECT_PRODUCT} ORDER BY id`);
    return result.rows.map(toProduct);
  }

  async findProductById(productId: string): Promise<Product | null> {
    const result = await this.database.query<ProductRow>(`${SELECT_PRODUCT} WHERE id = $1`, [productId]);
    const row = result.rows[0];
    return row === undefined ? null : toProduct(row);
  }

  async decrementStock(productId: string, quantity: number): Promise<number | null> {
    const result = await this.database.query<StockRow>(
      'UPDATE products SET stock = stock - $2 WHERE id = $1 AND stock >= $2 RETURNING stock',
      [productId, quantity],
    );
    if (result.rowCount !== 1) {
      return null;
    }
    return result.rows[0]?.stock ?? null;
  }
}

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    priceCents: row.price_cents,
    stock: row.stock,
  };
}
