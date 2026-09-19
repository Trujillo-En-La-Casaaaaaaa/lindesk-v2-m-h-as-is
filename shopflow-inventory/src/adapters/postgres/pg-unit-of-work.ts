import type { Pool, PoolClient } from 'pg';
import type { InventoryTransaction, UnitOfWork } from '../../ports/unit-of-work.js';
import { PgCatalogRepository } from './pg-catalog-repository.js';
import { PgStockLedgerRepository } from './pg-stock-ledger-repository.js';

/**
 * Runs a mutating use case in one PostgreSQL transaction on a dedicated pooled connection.
 *
 * The decrement writes the ledger row and the conditional stock update inside the same transaction,
 * so a crash between them can never leave one without the other. `READ COMMITTED` (the PostgreSQL
 * default) is what the guarded update relies on: a blocked update re-evaluates its condition once
 * the competing transaction commits.
 */
export class PgUnitOfWork implements UnitOfWork {
  constructor(private readonly pool: Pool) {}

  async runInTransaction<T>(work: (transaction: InventoryTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const transaction: InventoryTransaction = {
        catalog: new PgCatalogRepository(client),
        ledger: new PgStockLedgerRepository(client),
      };
      const result = await work(transaction);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch (error) {
    // Never mask the failure that caused the rollback.
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'rolling back a failed inventory transaction failed as well',
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
