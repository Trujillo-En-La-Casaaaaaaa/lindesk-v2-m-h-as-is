/**
 * The request failures this service can produce.
 *
 * Every error carries the HTTP status, the `code` of the two-field error envelope and the exact
 * `error` message documented in `apis/inventory-service-api.md` version 1, so the message and the
 * code are defined once and the HTTP adapter only has to serialize them.
 */

export type ErrorCode = 'INVALID' | 'NOT_FOUND' | 'INSUFFICIENT_STOCK' | 'STATE_CONFLICT';

export abstract class InventoryRequestError extends Error {
  abstract readonly status: number;
  abstract readonly code: ErrorCode;
}

/** 400 `INVALID` - the request body cannot be turned into a decrement. Never written to the ledger. */
export class InvalidStockDecrementRequestError extends InventoryRequestError {
  override readonly name = 'InvalidStockDecrementRequestError';
  readonly status = 400;
  readonly code = 'INVALID' as const;

  constructor() {
    super('A product id and a positive whole quantity are required');
  }
}

/** 404 `NOT_FOUND` - no product with that id (catalog lookup or a recorded decrement outcome). */
export class ProductNotFoundError extends InventoryRequestError {
  override readonly name = 'ProductNotFoundError';
  readonly status = 404;
  readonly code = 'NOT_FOUND' as const;

  constructor() {
    super('Product not found');
  }
}

/** 409 `INSUFFICIENT_STOCK` - the guarded update would have driven stock below zero. */
export class InsufficientStockError extends InventoryRequestError {
  override readonly name = 'InsufficientStockError';
  readonly status = 409;
  readonly code = 'INSUFFICIENT_STOCK' as const;

  constructor() {
    super('Insufficient stock');
  }
}

/** 409 `STATE_CONFLICT` - the decrement for this order id was already compensated. */
export class DecrementAlreadyReleasedError extends InventoryRequestError {
  override readonly name = 'DecrementAlreadyReleasedError';
  readonly status = 409;
  readonly code = 'STATE_CONFLICT' as const;

  constructor() {
    super('The decrement for this order was already released');
  }
}

/** 404 `NOT_FOUND` - the release addressed an order id this service never recorded. */
export class NoStockDecrementRecordedError extends InventoryRequestError {
  override readonly name = 'NoStockDecrementRecordedError';
  readonly status = 404;
  readonly code = 'NOT_FOUND' as const;

  constructor() {
    super('No stock decrement recorded for this order');
  }
}

/** 409 `STATE_CONFLICT` - the recorded outcome is `INSUFFICIENT_STOCK` or `NOT_FOUND`. */
export class DecrementNotReleasableError extends InventoryRequestError {
  override readonly name = 'DecrementNotReleasableError';
  readonly status = 409;
  readonly code = 'STATE_CONFLICT' as const;

  constructor() {
    super('Only a completed decrement can be released');
  }
}
