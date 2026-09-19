import type { CatalogRepository } from './catalog-repository.js';
import type { StockLedgerRepository } from './stock-ledger-repository.js';

/** The repository set that shares one database transaction. */
export interface InventoryTransaction {
  readonly catalog: CatalogRepository;
  readonly ledger: StockLedgerRepository;
}

/**
 * Transaction boundary for the mutating use cases.
 *
 * The decrement commits the ledger row and the conditional stock update together; either both
 * happen or neither does.
 */
export interface UnitOfWork {
  runInTransaction<T>(work: (transaction: InventoryTransaction) => Promise<T>): Promise<T>;
}
