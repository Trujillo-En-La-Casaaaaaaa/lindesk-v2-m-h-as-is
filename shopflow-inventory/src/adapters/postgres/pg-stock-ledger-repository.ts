import type { LedgerOutcome, LedgerState, StockDecrementRecord } from '../../domain/stock-decrement.js';
import type {
  NewStockDecrementRecord,
  StockLedgerRepository,
  StockRelease,
} from '../../ports/stock-ledger-repository.js';
import type { Queryable } from './queryable.js';

type LedgerRow = {
  order_id: string;
  product_id: string;
  quantity: number;
  outcome: LedgerOutcome;
  state: LedgerState;
  unit_price_cents: number | null;
  total_cents: number | null;
  remaining_stock: number | null;
};

type ReleaseRow = {
  released_quantity: number;
  remaining_stock: number;
};

const LEDGER_COLUMNS = 'order_id, product_id, quantity, outcome, state, unit_price_cents, total_cents, remaining_stock';

/**
 * The `stock_decrements` idempotency ledger of the service's own database.
 *
 * Every SQL statement the service uses against the ledger lives here; each one is written to be safe
 * on its own as well as inside the decrement/release transaction of `PgUnitOfWork`.
 */
export class PgStockLedgerRepository implements StockLedgerRepository {
  constructor(private readonly database: Queryable) {}

  async acquireOrderLock(orderId: string): Promise<void> {
    await this.database.query('SELECT pg_advisory_xact_lock(hashtext($1))', [orderId]);
  }

  async findForUpdate(orderId: string): Promise<StockDecrementRecord | null> {
    const result = await this.database.query<LedgerRow>(
      `SELECT ${LEDGER_COLUMNS} FROM stock_decrements WHERE order_id = $1 FOR UPDATE`,
      [orderId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async insert(entry: NewStockDecrementRecord): Promise<StockDecrementRecord> {
    const result = await this.database.query<LedgerRow>(
      `INSERT INTO stock_decrements
         (order_id, product_id, quantity, outcome, state, unit_price_cents, total_cents, remaining_stock)
       VALUES ($1, $2, $3, $4, 'RECORDED', $5, $6, $7)
       RETURNING ${LEDGER_COLUMNS}`,
      [
        entry.orderId,
        entry.productId,
        entry.quantity,
        entry.outcome,
        entry.unitPriceCents,
        entry.totalCents,
        entry.remainingStock,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`Recording the stock decrement for order ${entry.orderId} returned no row`);
    }
    return toRecord(row);
  }

  async release(orderId: string): Promise<StockRelease | null> {
    // One statement: the state transition and the stock increment cannot be torn apart, and the
    // `outcome = 'DECREMENTED' AND state = 'RECORDED'` guard matches a completed, not yet released
    // decrement only, so a duplicate release is a no-op instead of a double increment. The `EXISTS`
    // guard additionally guarantees the state never flips for a product row that is gone.
    const result = await this.database.query<ReleaseRow>(
      `WITH released AS (
         UPDATE stock_decrements
            SET state = 'RELEASED', updated_at = now()
          WHERE order_id = $1
            AND outcome = 'DECREMENTED'
            AND state = 'RECORDED'
            AND EXISTS (SELECT 1 FROM products WHERE products.id = stock_decrements.product_id)
          RETURNING product_id, quantity
       )
       UPDATE products
          SET stock = stock + released.quantity
         FROM released
        WHERE products.id = released.product_id
       RETURNING released.quantity AS released_quantity, products.stock AS remaining_stock`,
      [orderId],
    );
    if (result.rowCount !== 1) {
      return null;
    }
    const row = result.rows[0];
    return row === undefined
      ? null
      : { releasedQuantity: row.released_quantity, remainingStock: row.remaining_stock };
  }
}

function toRecord(row: LedgerRow): StockDecrementRecord {
  return {
    orderId: row.order_id,
    productId: row.product_id,
    quantity: row.quantity,
    outcome: row.outcome,
    state: row.state,
    unitPriceCents: row.unit_price_cents,
    totalCents: row.total_cents,
    remainingStock: row.remaining_stock,
  };
}
