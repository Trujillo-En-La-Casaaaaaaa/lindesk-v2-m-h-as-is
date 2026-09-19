import { Pool, type PoolClient, type QueryResult } from "pg";
import type { Order, Product } from "../../domain/models.js";
import type { OrderPort, ProductPort, UnitOfWorkPort } from "../../ports/index.js";

const productColumns = 'id, sku, name, price_cents AS "priceCents", stock';
const orderColumns = 'id, customer_email AS "customerEmail", status, product_id AS "productId", quantity, total_cents AS "totalCents", created_at AS "createdAt"';

type Queryable = Pick<Pool | PoolClient, "query">;

class Products implements ProductPort {
  constructor(private readonly db: Queryable) {}
  async list(): Promise<Product[]> {
    return (await this.db.query(`SELECT ${productColumns} FROM products ORDER BY id`)).rows;
  }
  async getById(id: string): Promise<Product | null> {
    const result = await this.db.query(`SELECT ${productColumns} FROM products WHERE id = $1 FOR UPDATE`, [id]);
    return result.rows[0] ?? null;
  }
  async decrementStock(id: string, quantity: number): Promise<boolean> {
    const result = await this.db.query("UPDATE products SET stock = stock - $2 WHERE id = $1 AND stock >= $2", [id, quantity]);
    return result.rowCount === 1;
  }
}

class Orders implements OrderPort {
  constructor(private readonly db: Queryable) {}
  async getById(id: string): Promise<Order | null> {
    const result = await this.db.query(`SELECT ${orderColumns} FROM orders WHERE id = $1`, [id]);
    return result.rows[0] ?? null;
  }
  async create(order: Order): Promise<void> {
    await this.db.query(
      "INSERT INTO orders (id, customer_email, status, product_id, quantity, total_cents, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [order.id, order.customerEmail, order.status, order.productId, order.quantity, order.totalCents, order.createdAt]
    );
  }
  async markShipped(id: string): Promise<Order | null> {
    const result: QueryResult<Order> = await this.db.query(
      `UPDATE orders SET status = 'SHIPPED' WHERE id = $1 AND status = 'CONFIRMED' RETURNING ${orderColumns}`,
      [id]
    );
    return result.rows[0] ?? null;
  }
}

export class PostgresStore implements UnitOfWorkPort {
  readonly products: ProductPort;
  readonly orders: OrderPort;

  constructor(private readonly pool: Pool) {
    this.products = new Products(pool);
    this.orders = new Orders(pool);
  }

  async execute<T>(work: (products: ProductPort, orders: OrderPort) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(new Products(client), new Orders(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createPool(): Pool {
  return new Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://shopflow:shopflow@localhost:5432/shopflow" });
}
