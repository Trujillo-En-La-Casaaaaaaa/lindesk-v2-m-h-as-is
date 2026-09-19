import type { Product } from '../domain/product.js';
import { ProductNotFoundError } from '../domain/errors.js';
import type { CatalogRepository } from '../ports/catalog-repository.js';

/** Read-only catalog use cases behind `GET /products` and `GET /products/:id`. */
export class CatalogService {
  constructor(private readonly catalog: CatalogRepository) {}

  listProducts(): Promise<Product[]> {
    return this.catalog.listProducts();
  }

  async getProduct(productId: string): Promise<Product> {
    const product = await this.catalog.findProductById(productId);
    if (product === null) {
      throw new ProductNotFoundError();
    }
    return product;
  }
}
