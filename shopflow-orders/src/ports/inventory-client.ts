/**
 * The frozen `shopflow-inventory` interface (version 1) as this service needs it.
 *
 * `POST /stock-decrements` with `Idempotency-Key: <orderId>` is the only way this service changes
 * stock, and `POST /stock-decrements/:orderId/release` is the only compensation. Neither the product
 * catalog nor the stock rules live here: the client relays the inventory outcome, including its
 * price snapshot for `totalCents`.
 *
 * `UNAVAILABLE` is deliberately one bucket for every unanswerable call (timeout, connection failure,
 * 5xx, undocumented response): the contract cannot tell us whether the decrement happened, which is
 * exactly the `UNCERTAIN` situation of the saga.
 */

export interface StockDecrementRequest {
  readonly orderId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly correlationId?: string | undefined;
}

export type StockDecrementOutcome =
  | {
      readonly kind: 'DECREMENTED';
      readonly unitPriceCents: number;
      readonly totalCents: number;
      readonly remainingStock: number | null;
      /** `true` when inventory replayed a previously recorded decrement for this order id. */
      readonly replayed: boolean;
    }
  | { readonly kind: 'INSUFFICIENT_STOCK' }
  | { readonly kind: 'PRODUCT_NOT_FOUND' }
  | { readonly kind: 'ALREADY_RELEASED' }
  | { readonly kind: 'UNAVAILABLE'; readonly detail: string };

export type StockReleaseOutcome =
  | { readonly kind: 'RELEASED'; readonly releasedQuantity: number | null }
  | { readonly kind: 'NOT_RECORDED'; readonly detail: string }
  | { readonly kind: 'NOT_RELEASABLE'; readonly detail: string }
  | { readonly kind: 'UNAVAILABLE'; readonly detail: string };

export interface InventoryClient {
  decrementStock(request: StockDecrementRequest): Promise<StockDecrementOutcome>;
  releaseStock(orderId: string, correlationId?: string | undefined): Promise<StockReleaseOutcome>;
}
