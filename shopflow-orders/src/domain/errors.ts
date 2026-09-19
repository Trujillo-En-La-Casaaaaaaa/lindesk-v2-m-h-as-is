/**
 * The error vocabulary of `apis/orders-service-api.md` version 1.
 *
 * Every documented failure mode has exactly one class here, so the HTTP adapter never invents a
 * status or a message. The error envelope carries exactly two fields (`error`, `code`) for the
 * documented failures; the `500` failure is the one documented body that carries only `error`.
 */

export const LEGACY_MESSAGES = {
  invalid: 'A product, positive whole quantity, and valid email are required',
  insufficientStock: 'Insufficient stock',
  productNotFound: 'Product not found',
  orderNotFound: 'Order not found',
  invalidStatus: 'Only CONFIRMED orders can be shipped',
  unavailable: 'Upstream service unavailable',
  internal: 'Internal server error',
} as const;

export type OrdersErrorCode = 'INVALID' | 'INSUFFICIENT_STOCK' | 'NOT_FOUND' | 'INVALID_STATUS' | 'UNAVAILABLE';

export type ErrorEnvelope = { readonly error: string; readonly code?: string };

/** Base class of the documented failures: a status, the legacy message and the legacy code. */
export abstract class OrdersRequestError extends Error {
  protected constructor(
    readonly status: number,
    message: string,
    readonly code: OrdersErrorCode,
  ) {
    super(message);
    this.name = new.target.name;
  }

  /** The documented body. `code` is present for every documented failure except the internal one. */
  envelope(): ErrorEnvelope {
    return { error: this.message, code: this.code };
  }
}

export class InvalidOrderRequestError extends OrdersRequestError {
  constructor() {
    super(400, LEGACY_MESSAGES.invalid, 'INVALID');
  }
}

export class InsufficientStockError extends OrdersRequestError {
  constructor() {
    super(400, LEGACY_MESSAGES.insufficientStock, 'INSUFFICIENT_STOCK');
  }
}

export class ProductNotFoundError extends OrdersRequestError {
  constructor() {
    super(404, LEGACY_MESSAGES.productNotFound, 'NOT_FOUND');
  }
}

export class OrderNotFoundError extends OrdersRequestError {
  constructor() {
    super(404, LEGACY_MESSAGES.orderNotFound, 'NOT_FOUND');
  }
}

export class OrderNotShippableError extends OrdersRequestError {
  constructor() {
    super(409, LEGACY_MESSAGES.invalidStatus, 'INVALID_STATUS');
  }
}

export class UpstreamUnavailableError extends OrdersRequestError {
  constructor() {
    super(503, LEGACY_MESSAGES.unavailable, 'UNAVAILABLE');
  }
}

/**
 * The internal failure. Its documented body carries a single field, so it is not an
 * `OrdersRequestError`: `errorEnvelope` gives it the documented shape.
 */
export class InternalOrderError extends Error {
  override readonly name = 'InternalOrderError';
  readonly status = 500;

  constructor(readonly detail: string) {
    super(LEGACY_MESSAGES.internal);
  }

  envelope(): ErrorEnvelope {
    return { error: LEGACY_MESSAGES.internal };
  }
}

/** The documented body of any failure, HTTP facing. */
export function errorEnvelope(error: unknown): ErrorEnvelope {
  if (error instanceof OrdersRequestError || error instanceof InternalOrderError) {
    return error.envelope();
  }
  return { error: LEGACY_MESSAGES.internal };
}

export function errorDetail(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
