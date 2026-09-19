/**
 * HTTP adapter of the frozen `shopflow-inventory` contract (version 1).
 *
 * One call, one meaning: `POST /stock-decrements` with `Idempotency-Key: <orderId>` - the order id
 * is generated first and is the ledger key, so a retry can never decrement twice. The response is
 * relayed as-is (`unitPriceCents` is the price snapshot used for `totalCents`); no stock arithmetic
 * happens in this repository.
 */

import { errorDetail } from '../../logging.js';
import type {
  InventoryClient,
  StockDecrementOutcome,
  StockDecrementRequest,
  StockReleaseOutcome,
} from '../../ports/inventory-client.js';

export interface HttpInventoryClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch | undefined;
}

export class HttpInventoryClient implements InventoryClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpInventoryClientOptions) {
    const baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
    if (baseUrl === '') {
      throw new Error('INVENTORY_URL must not be empty');
    }
    this.baseUrl = baseUrl;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  async decrementStock(request: StockDecrementRequest): Promise<StockDecrementOutcome> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/stock-decrements`, {
        method: 'POST',
        headers: this.headers({ 'idempotency-key': request.orderId }, request.correlationId),
        body: JSON.stringify({
          orderId: request.orderId,
          productId: request.productId,
          quantity: request.quantity,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      return { kind: 'UNAVAILABLE', detail: errorDetail(error) };
    }

    const body = await readJson(response);
    const code = envelopeCode(body);

    if (response.status === 201 || response.status === 200) {
      const parsed = parseDecrementBody(body, response.headers.get('x-idempotent-replay') === 'true');
      if (parsed === null) {
        return {
          kind: 'UNAVAILABLE',
          detail: `the inventory response to a recorded decrement was not understood (status ${response.status})`,
        };
      }
      return parsed;
    }
    if (response.status === 404) {
      return { kind: 'PRODUCT_NOT_FOUND' };
    }
    if (response.status === 409) {
      if (code === 'INSUFFICIENT_STOCK') {
        return { kind: 'INSUFFICIENT_STOCK' };
      }
      if (code === 'STATE_CONFLICT') {
        return { kind: 'ALREADY_RELEASED' };
      }
      return { kind: 'UNAVAILABLE', detail: `unexpected inventory conflict (status 409, code ${code ?? 'none'})` };
    }
    return {
      kind: 'UNAVAILABLE',
      detail: `the inventory decrement answered ${response.status} (code ${code ?? 'none'})`,
    };
  }

  async releaseStock(orderId: string, correlationId?: string | undefined): Promise<StockReleaseOutcome> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/stock-decrements/${encodeURIComponent(orderId)}/release`,
        {
          method: 'POST',
          headers: this.headers({}, correlationId),
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch (error) {
      return { kind: 'UNAVAILABLE', detail: errorDetail(error) };
    }

    const body = await readJson(response);
    if (response.status === 200) {
      const releasedQuantity = isRecord(body) ? body['releasedQuantity'] : undefined;
      return {
        kind: 'RELEASED',
        releasedQuantity: typeof releasedQuantity === 'number' ? releasedQuantity : null,
      };
    }
    if (response.status === 404) {
      return { kind: 'NOT_RECORDED', detail: 'the inventory service records no decrement for this order id' };
    }
    if (response.status === 409) {
      return { kind: 'NOT_RELEASABLE', detail: 'the recorded outcome of this order id cannot be released' };
    }
    return { kind: 'UNAVAILABLE', detail: `the inventory release answered ${response.status}` };
  }

  private headers(extra: Record<string, string>, correlationId?: string | undefined): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...extra };
    if (correlationId !== undefined && correlationId !== '') {
      headers['x-correlation-id'] = correlationId;
    }
    return headers;
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  if (text.trim() === '') {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function envelopeCode(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const code = body['code'];
  return typeof code === 'string' ? code : undefined;
}

/** The relayed decrement: the inventory service's own numbers, never recomputed here. */
function parseDecrementBody(body: unknown, replayed: boolean): StockDecrementOutcome | null {
  if (!isRecord(body)) {
    return null;
  }
  const unitPriceCents = body['unitPriceCents'];
  const totalCents = body['totalCents'];
  const remainingStock = body['remainingStock'];
  if (typeof unitPriceCents !== 'number' || !Number.isInteger(unitPriceCents)) {
    return null;
  }
  if (typeof totalCents !== 'number' || !Number.isInteger(totalCents)) {
    return null;
  }
  return {
    kind: 'DECREMENTED',
    unitPriceCents,
    totalCents,
    remainingStock: typeof remainingStock === 'number' ? remainingStock : null,
    replayed,
  };
}
