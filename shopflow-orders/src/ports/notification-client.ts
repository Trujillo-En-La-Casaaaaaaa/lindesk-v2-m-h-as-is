/**
 * The frozen `shopflow-notifications` interface (version 1) as this service needs it.
 *
 * This service never talks to the provider: it dispatches an order-confirmation intent with
 * `Idempotency-Key: ORDER_CONFIRMATION:<orderId>` and treats every non-2xx answer (including the
 * `502 PROVIDER_UNAVAILABLE` of the notifications service) as a failed attempt that the outbox
 * retries.
 */

export interface OrderConfirmationIntent {
  readonly orderId: string;
  readonly customerEmail: string;
  readonly correlationId?: string | undefined;
}

export type NotificationDispatchResult =
  | { readonly delivered: true }
  | { readonly delivered: false; readonly error: string };

export interface NotificationClient {
  dispatchOrderConfirmation(intent: OrderConfirmationIntent): Promise<NotificationDispatchResult>;
}
