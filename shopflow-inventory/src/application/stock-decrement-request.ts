import { InvalidStockDecrementRequestError } from '../domain/errors.js';

/** A validated `POST /stock-decrements` request. */
export interface StockDecrementRequest {
  readonly orderId: string;
  readonly productId: string;
  readonly quantity: number;
}

/** Any textual UUID form PostgreSQL accepts for the `order_id UUID` column. */
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates the `Idempotency-Key` header and the request body.
 *
 * A missing header, a body `orderId` that differs from the header, an unusable order id, a missing
 * product id or a quantity that is not a positive whole number is `400 INVALID`. Such a request is
 * never recorded: the ledger stores only the outcomes `DECREMENTED`, `INSUFFICIENT_STOCK` and
 * `NOT_FOUND`, and the order id has to be trustworthy (a UUID, as the ledger column requires) before
 * anything is written for it.
 */
export function parseStockDecrementRequest(idempotencyKey: unknown, body: unknown): StockDecrementRequest {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
    throw new InvalidStockDecrementRequestError();
  }
  const payload = isRecord(body) ? body : {};
  const orderId = payload.orderId;
  if (typeof orderId !== 'string' || orderId !== idempotencyKey || !isUuid(orderId)) {
    throw new InvalidStockDecrementRequestError();
  }
  const productId = payload.productId;
  if (typeof productId !== 'string' || productId.trim() === '') {
    throw new InvalidStockDecrementRequestError();
  }
  const quantity = payload.quantity;
  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity <= 0) {
    throw new InvalidStockDecrementRequestError();
  }
  return { orderId, productId, quantity };
}
