import { ORDER_CONFIRMATION } from '../domain/notification.js';

export type ProviderFailureKind = 'PROVIDER_ERROR' | 'PROVIDER_TIMEOUT';

/**
 * Provider payload - exactly the three legacy fields, in the legacy order.
 * Extra fields would change the message recorded by the provider.
 */
export interface ProviderOrderConfirmationPayload {
  readonly type: typeof ORDER_CONFIRMATION;
  readonly orderId: string;
  readonly customerEmail: string;
}

/** A record as returned by the provider's inspection endpoint. */
export interface ProviderNotificationRecord {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly orderId?: unknown;
  readonly order_id?: unknown;
  readonly [key: string]: unknown;
}

export interface ProviderAcceptance {
  readonly id: string;
}

/** A provider call that failed; `kind` maps to the attempt-history outcome. */
export class ProviderError extends Error {
  readonly kind: ProviderFailureKind;
  readonly detail: string;

  constructor(kind: ProviderFailureKind, detail: string) {
    super(detail);
    this.name = 'ProviderError';
    this.kind = kind;
    this.detail = detail;
  }
}

/**
 * Outbound port for the unchanged external provider contract:
 * `POST /notifications`, `GET /notifications` (inspection) and `GET /health`.
 */
export interface NotificationProvider {
  /** `POST {PROVIDER_URL}/notifications` with the legacy 3 s timeout. */
  sendOrderConfirmation(payload: ProviderOrderConfirmationPayload): Promise<ProviderAcceptance>;

  /** `GET {PROVIDER_URL}/notifications` - used before every retry to reconcile. */
  listNotifications(): Promise<ProviderNotificationRecord[]>;
}
