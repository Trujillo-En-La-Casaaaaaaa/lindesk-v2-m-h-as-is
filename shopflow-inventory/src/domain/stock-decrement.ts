/**
 * The stock-decrement ledger record.
 *
 * One row exists per order id that reached `POST /stock-decrements`, including the rejected ones, so
 * that a repeat call can replay the recorded outcome instead of mutating stock again.
 */

/** The terminal outcome recorded for an order id. */
export type LedgerOutcome = 'DECREMENTED' | 'INSUFFICIENT_STOCK' | 'NOT_FOUND';

/** `RECORDED` until the compensating release has been applied, `RELEASED` afterwards (terminal). */
export type LedgerState = 'RECORDED' | 'RELEASED';

export interface StockDecrementRecord {
  readonly orderId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly outcome: LedgerOutcome;
  readonly state: LedgerState;
  /** Snapshot of the product price used for `totalCents`; null unless the outcome is DECREMENTED. */
  readonly unitPriceCents: number | null;
  /** `unitPriceCents * quantity`; null unless the outcome is DECREMENTED. */
  readonly totalCents: number | null;
  /** Stock left directly after the decrement; null unless the outcome is DECREMENTED. */
  readonly remainingStock: number | null;
}
