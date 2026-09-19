/**
 * HTTP adapter of the frozen `shopflow-notifications` contract (version 1).
 *
 * `POST /notifications/order-confirmations` with `Idempotency-Key: ORDER_CONFIRMATION:<orderId>`.
 * Every non-2xx answer is a failed dispatch - including the `502 PROVIDER_UNAVAILABLE` the
 * notifications service answers when its provider is down - which leaves the outbox row `PENDING` for
 * the background retry. This service never talks to the provider itself.
 */

import type { NotificationClient, NotificationDispatchResult, OrderConfirmationIntent } from '../../ports/notification-client.js';

export const ORDER_CONFIRMATION_PATH = '/notifications/order-confirmations';

export interface HttpNotificationClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch | undefined;
}

export class HttpNotificationClient implements NotificationClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpNotificationClientOptions) {
    const baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
    if (baseUrl === '') {
      throw new Error('NOTIFICATIONS_URL must not be empty');
    }
    this.baseUrl = baseUrl;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  async dispatchOrderConfirmation(intent: OrderConfirmationIntent): Promise<NotificationDispatchResult> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKeyForOrderConfirmation(intent.orderId),
    };
    if (intent.correlationId !== undefined && intent.correlationId !== '') {
      headers['x-correlation-id'] = intent.correlationId;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${ORDER_CONFIRMATION_PATH}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          type: 'ORDER_CONFIRMATION',
          orderId: intent.orderId,
          customerEmail: intent.customerEmail,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      return { delivered: false, error: error instanceof Error ? error.message : String(error) };
    }

    if (response.status >= 200 && response.status < 300) {
      return { delivered: true };
    }

    const detail = await response.text().catch(() => '');
    return {
      delivered: false,
      error: `the notifications service answered ${response.status}${detail.trim() === '' ? '' : `: ${detail.trim().slice(0, 200)}`}`,
    };
  }
}

/** The frozen agreement between this producer and `shopflow-notifications` version 1. */
export function idempotencyKeyForOrderConfirmation(orderId: string): string {
  return `ORDER_CONFIRMATION:${orderId}`;
}
