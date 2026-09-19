import type { StockDecrementRecord } from '../domain/stock-decrement.js';
import {
  DecrementAlreadyReleasedError,
  DecrementNotReleasableError,
  NoStockDecrementRecordedError,
} from '../domain/errors.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { isUuid, type StockDecrementRequest } from './stock-decrement-request.js';

/**
 * The outcome of `POST /stock-decrements`.
 *
 * `record.outcome` is the recorded outcome (`DECREMENTED`, `INSUFFICIENT_STOCK` or `NOT_FOUND`) and
 * `replayed` is true when the call repeated a known order id instead of executing again. The record
 * is the same one that was written by the first execution, which is why a replay returns the stored
 * body byte for byte.
 */
export interface DecrementStockOutcome {
  readonly record: StockDecrementRecord;
  readonly replayed: boolean;
}

/** The outcome of `POST /stock-decrements/:orderId/release`. */
export interface ReleaseStockOutcome {
  readonly orderId: string;
  readonly releasedQuantity: number;
  readonly remainingStock: number;
  /** True when this call found the decrement already released. */
  readonly replayed: boolean;
}

/**
 * The only two stock mutations in this service: the idempotent decrement and its compensating
 * release. Both run inside one database transaction.
 */
export class StockService {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  /**
   * Decrements stock for an order id at most once ever.
   *
   * The ledger row and the guarded `stock = stock - quantity ... AND stock >= quantity` update commit
   * together. A known order id is replayed from the recorded outcome without touching stock, and the
   * rejected outcomes (`INSUFFICIENT_STOCK`, `NOT_FOUND`) are recorded as well so that a retry
   * replays them instead of re-evaluating them against changed data.
   */
  async decrementStock(request: StockDecrementRequest): Promise<DecrementStockOutcome> {
    return this.unitOfWork.runInTransaction(async (transaction) => {
      // Same order id => serialized; different order ids still race on the row lock of the guarded
      // update in PgCatalogRepository#decrementStock.
      await transaction.ledger.acquireOrderLock(request.orderId);

      const recorded = await transaction.ledger.findForUpdate(request.orderId);
      if (recorded !== null) {
        if (recorded.outcome === 'DECREMENTED' && recorded.state === 'RELEASED') {
          throw new DecrementAlreadyReleasedError();
        }
        return { record: recorded, replayed: true };
      }

      const product = await transaction.catalog.findProductById(request.productId);
      if (product === null) {
        const record = await transaction.ledger.insert({
          orderId: request.orderId,
          productId: request.productId,
          quantity: request.quantity,
          outcome: 'NOT_FOUND',
          unitPriceCents: null,
          totalCents: null,
          remainingStock: null,
        });
        return { record, replayed: false };
      }

      const remainingStock = await transaction.catalog.decrementStock(request.productId, request.quantity);
      if (remainingStock === null) {
        const record = await transaction.ledger.insert({
          orderId: request.orderId,
          productId: request.productId,
          quantity: request.quantity,
          outcome: 'INSUFFICIENT_STOCK',
          unitPriceCents: null,
          totalCents: null,
          remainingStock: null,
        });
        return { record, replayed: false };
      }

      const record = await transaction.ledger.insert({
        orderId: request.orderId,
        productId: request.productId,
        quantity: request.quantity,
        outcome: 'DECREMENTED',
        unitPriceCents: product.priceCents,
        totalCents: product.priceCents * request.quantity,
        remainingStock,
      });
      return { record, replayed: false };
    });
  }

  /**
   * Compensates a recorded decrement: stock is incremented by the recorded quantity exactly once ever.
   *
   * An order id this service never recorded is `404`; a recorded but rejected outcome
   * (`INSUFFICIENT_STOCK`, `NOT_FOUND`) is `409 STATE_CONFLICT`; a repeated release replays the
   * recorded release instead of incrementing again.
   */
  async releaseStock(orderId: string): Promise<ReleaseStockOutcome> {
    if (!isUuid(orderId)) {
      // Not a possible ledger key, so there is nothing to record and nothing to release.
      throw new NoStockDecrementRecordedError();
    }
    return this.unitOfWork.runInTransaction(async (transaction) => {
      await transaction.ledger.acquireOrderLock(orderId);

      const recorded = await transaction.ledger.findForUpdate(orderId);
      if (recorded === null) {
        throw new NoStockDecrementRecordedError();
      }
      if (recorded.outcome !== 'DECREMENTED') {
        throw new DecrementNotReleasableError();
      }
      if (recorded.state === 'RELEASED') {
        const product = await transaction.catalog.findProductById(recorded.productId);
        if (product === null) {
          throw new Error(`Product ${recorded.productId} of released decrement ${orderId} is missing`);
        }
        return {
          orderId,
          releasedQuantity: recorded.quantity,
          remainingStock: product.stock,
          replayed: true,
        };
      }

      const released = await transaction.ledger.release(orderId);
      if (released === null) {
        // Unreachable for a DECREMENTED row whose product still exists: fail closed instead of
        // answering 200 without an increment.
        throw new Error(`The guarded release of decrement ${orderId} matched no row`);
      }
      return {
        orderId,
        releasedQuantity: released.releasedQuantity,
        remainingStock: released.remainingStock,
        replayed: false,
      };
    });
  }
}
