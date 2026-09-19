import type { LedgerOutcome, StockDecrementRecord } from '../domain/stock-decrement.js';

/** A ledger row to be written for an order id that reached the decrement or the release use case. */
export interface NewStockDecrementRecord {
  readonly orderId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly outcome: LedgerOutcome;
  readonly unitPriceCents: number | null;
  readonly totalCents: number | null;
  readonly remainingStock: number | null;
}

/** The result of the guarded release statement. */
export interface StockRelease {
  readonly releasedQuantity: number;
  readonly remainingStock: number;
}

/**
 * Outbound port for the `stock_decrements` idempotency ledger.
 *
 * Implemented by `src/adapters/postgres/pg-stock-ledger-repository.ts`.
 */
export interface StockLedgerRepository {
  /**
   * Serializes concurrent work for one order id inside the current transaction, so two simultaneous
   * calls for the same order id cannot both pass the "no row recorded yet" check.
   */
  acquireOrderLock(orderId: string): Promise<void>;
  /** The ledger row for this order id, locked for the rest of the transaction, or `null`. */
  findForUpdate(orderId: string): Promise<StockDecrementRecord | null>;
  /** Records the outcome of an order id that was not recorded before. */
  insert(entry: NewStockDecrementRecord): Promise<StockDecrementRecord>;
  /**
   * Compensating release in one guarded statement: increments `products.stock` by the recorded
   * quantity and flips `state` to `RELEASED`, matching only a completed, not yet released decrement
   * (`outcome = 'DECREMENTED' AND state = 'RECORDED'`) so a duplicate release cannot increment twice.
   * Returns `null` when no row matched.
   */
  release(orderId: string): Promise<StockRelease | null>;
}
