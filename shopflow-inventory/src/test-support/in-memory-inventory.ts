import type { Product } from '../domain/product.js';
import type { LedgerOutcome, StockDecrementRecord } from '../domain/stock-decrement.js';
import type { CatalogRepository } from '../ports/catalog-repository.js';
import type {
  NewStockDecrementRecord,
  StockLedgerRepository,
  StockRelease,
} from '../ports/stock-ledger-repository.js';
import type { InventoryTransaction, UnitOfWork } from '../ports/unit-of-work.js';

/**
 * In-memory stand-ins for the two outbound ports, used by the unit tests only.
 *
 * The unit tests must prove the use-case behaviour (validation branches, replays, release guards)
 * without a database; the integration tests prove the same behaviour against a real PostgreSQL 17
 * instance and the real `pg` adapters. Nothing in `src/main.ts` or `src/composition.ts` imports this
 * module: it is a test double, never a runtime fallback.
 */

/** The deterministic seed of `schema/inventory-schema.sql`. */
export const SEEDED_PRODUCTS: readonly Product[] = [
  { id: 'product-a', sku: 'SKU-A', name: 'Product A', priceCents: 1200, stock: 10 },
  { id: 'product-b', sku: 'SKU-B', name: 'Product B', priceCents: 2500, stock: 5 },
];

interface InventoryState {
  products: Map<string, Product>;
  ledger: Map<string, StockDecrementRecord>;
}

export class InMemoryInventory implements UnitOfWork {
  private state: InventoryState = {
    products: new Map(SEEDED_PRODUCTS.map((product) => [product.id, product])),
    ledger: new Map(),
  };

  /** Successful guarded stock updates: a replay must not increase this counter. */
  stockUpdates = 0;
  /** Ledger rows written: a replay must not increase this counter either. */
  ledgerWrites = 0;
  commits = 0;
  rollbacks = 0;

  readonly catalog: CatalogRepository = {
    listProducts: async () => [...this.state.products.values()],
    findProductById: async (productId: string) => this.state.products.get(productId) ?? null,
    decrementStock: async (productId: string, quantity: number) => {
      const product = this.state.products.get(productId);
      if (product === undefined || product.stock < quantity) {
        return null;
      }
      const stock = product.stock - quantity;
      this.state.products.set(productId, { ...product, stock });
      this.stockUpdates += 1;
      return stock;
    },
  };

  readonly ledger: StockLedgerRepository = {
    acquireOrderLock: async () => undefined,
    findForUpdate: async (orderId: string) => this.state.ledger.get(orderId) ?? null,
    insert: async (entry: NewStockDecrementRecord) => {
      if (this.state.ledger.has(entry.orderId)) {
        throw new Error(`duplicate key value violates unique constraint "stock_decrements_pkey" (${entry.orderId})`);
      }
      const record: StockDecrementRecord = { ...entry, state: 'RECORDED' };
      this.state.ledger.set(entry.orderId, record);
      this.ledgerWrites += 1;
      return record;
    },
    release: async (orderId: string) => {
      const record = this.state.ledger.get(orderId);
      if (record === undefined || record.outcome !== 'DECREMENTED' || record.state !== 'RECORDED') {
        return null;
      }
      const product = this.state.products.get(record.productId);
      if (product === undefined) {
        return null;
      }
      const remainingStock = product.stock + record.quantity;
      this.state.products.set(record.productId, { ...product, stock: remainingStock });
      this.state.ledger.set(orderId, { ...record, state: 'RELEASED' });
      this.ledgerWrites += 1;
      const release: StockRelease = { releasedQuantity: record.quantity, remainingStock };
      return release;
    },
  };

  async runInTransaction<T>(work: (transaction: InventoryTransaction) => Promise<T>): Promise<T> {
    const products = new Map(this.state.products);
    const ledger = new Map(this.state.ledger);
    const stockUpdates = this.stockUpdates;
    const ledgerWrites = this.ledgerWrites;
    try {
      const result = await work({ catalog: this.catalog, ledger: this.ledger });
      this.commits += 1;
      return result;
    } catch (error) {
      // A real transaction rolls back every effect, so the double rolls back the counters too.
      this.state = { ...this.state, products, ledger };
      this.stockUpdates = stockUpdates;
      this.ledgerWrites = ledgerWrites;
      this.rollbacks += 1;
      throw error;
    }
  }

  stockOf(productId: string): number {
    const product = this.state.products.get(productId);
    if (product === undefined) {
      throw new Error(`unknown product ${productId}`);
    }
    return product.stock;
  }

  ledgerEntry(orderId: string): StockDecrementRecord | undefined {
    return this.state.ledger.get(orderId);
  }

  ledgerSize(): number {
    return this.state.ledger.size;
  }

  recordedOutcomes(): LedgerOutcome[] {
    return [...this.state.ledger.values()].map((record) => record.outcome);
  }
}
