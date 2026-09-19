/**
 * Input validation of `POST /orders`, exactly as the retired monolith did it: one message for every
 * rejected shape (missing/blank/typed-wrong `productId`, non-positive or fractional `quantity`,
 * malformed `customerEmail`).
 *
 * The optional client `Idempotency-Key` header is validated here as well: absent (or blank) means the
 * legacy behaviour without any replay support, present means one replayable creation intent. An
 * unbounded header would be unbounded state, so an oversized key is the same `400 INVALID` the rest
 * of the request validation produces.
 */

import { InvalidOrderRequestError } from './errors.js';

export const MAX_CLIENT_IDEMPOTENCY_KEY_LENGTH = 255;
export const MAX_CUSTOMER_EMAIL_LENGTH = 320;
export const MAX_PRODUCT_ID_LENGTH = 200;

export interface OrderRequestInput {
  readonly productId: string;
  readonly quantity: number;
  readonly customerEmail: string;
}

/**
 * The legacy "valid email" rule: one local part, one domain with at least one dot, no whitespace.
 * The notifications contract itself only requires an `@`, and everything a legacy client could send
 * keeps working.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseOrderRequest(body: unknown): OrderRequestInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new InvalidOrderRequestError();
  }
  const record = body as Record<string, unknown>;

  const productId = record['productId'];
  if (typeof productId !== 'string') {
    throw new InvalidOrderRequestError();
  }
  const trimmedProductId = productId.trim();
  if (trimmedProductId === '' || trimmedProductId.length > MAX_PRODUCT_ID_LENGTH) {
    throw new InvalidOrderRequestError();
  }

  const quantity = record['quantity'];
  if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new InvalidOrderRequestError();
  }

  const customerEmail = record['customerEmail'];
  if (typeof customerEmail !== 'string') {
    throw new InvalidOrderRequestError();
  }
  const trimmedEmail = customerEmail.trim();
  if (
    trimmedEmail === '' ||
    trimmedEmail.length > MAX_CUSTOMER_EMAIL_LENGTH ||
    !EMAIL_PATTERN.test(trimmedEmail)
  ) {
    throw new InvalidOrderRequestError();
  }

  return { productId: trimmedProductId, quantity, customerEmail: trimmedEmail };
}

/** `null` when the header is absent or blank: the request is then exactly the legacy one. */
export function parseClientIdempotencyKey(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }
  const key = header.trim();
  if (key === '') {
    return null;
  }
  if (key.length > MAX_CLIENT_IDEMPOTENCY_KEY_LENGTH) {
    throw new InvalidOrderRequestError();
  }
  return key;
}
