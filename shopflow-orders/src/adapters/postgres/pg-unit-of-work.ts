/**
 * Runs one use case in one PostgreSQL transaction on a dedicated pooled connection, with the store
 * bound to that connection. This is what makes step 8 of the saga atomic: the order row, the outbox
 * row and the saga completion either all commit or none of them does.
 */

import type { Pool, PoolClient } from 'pg';
import { logJson } from '../../logging.js';
import type { OrderStore, OrderUnitOfWork } from '../../ports/order-store.js';
import { PgOrderStore, type PgOrderStoreOptions } from './pg-order-store.js';

export class PgOrderUnitOfWork implements OrderUnitOfWork {
  constructor(
    private readonly pool: Pool,
    private readonly options: PgOrderStoreOptions = {},
  ) {}

  async runInTransaction<T>(work: (transaction: OrderStore) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(new PgOrderStore(client, this.options));
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
    logJson(
      'error',
      'rolling back a failed orders transaction failed as well',
      error instanceof Error ? error.message : String(error),
    );
  }
}
