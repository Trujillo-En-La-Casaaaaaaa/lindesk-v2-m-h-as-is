/**
 * The production composition root: HTTP adapter -> application services -> the ports.
 *
 * The tests use this same function (the unit tests override the two remote clients with records of
 * the frozen contracts, the integration tests run it over a real database and the real inventory and
 * notifications services), so what the tests exercise is what the container runs.
 */

import type { Express } from 'express';
import type { Pool } from 'pg';
import { createOrdersApp } from './adapters/http/app.js';
import { HttpInventoryClient } from './adapters/inventory/http-inventory-client.js';
import { HttpNotificationClient } from './adapters/notifications/http-notification-client.js';
import { PgOrderStore } from './adapters/postgres/pg-order-store.js';
import { PgOrderUnitOfWork } from './adapters/postgres/pg-unit-of-work.js';
import { OrderService } from './application/order-service.js';
import { OrderCreationService } from './application/saga/order-creation-service.js';
import { OutboxDispatcher } from './application/saga/outbox-dispatcher.js';
import { SagaRecoveryService } from './application/saga/saga-recovery-service.js';
import type { OrdersConfig } from './config.js';
import { defaultErrorLogger, type ErrorLogger } from './logging.js';
import type { InventoryClient } from './ports/inventory-client.js';
import type { NotificationClient } from './ports/notification-client.js';
import type { OrderStore, OrderUnitOfWork } from './ports/order-store.js';

export interface OrdersRuntimeOverrides {
  readonly inventory?: InventoryClient | undefined;
  readonly notifications?: NotificationClient | undefined;
  readonly now?: (() => Date) | undefined;
  readonly logError?: ErrorLogger | undefined;
}

export interface OrdersRuntime {
  readonly app: Express;
  readonly store: OrderStore;
  readonly unitOfWork: OrderUnitOfWork;
  readonly creation: OrderCreationService;
  readonly outbox: OutboxDispatcher;
  readonly recovery: SagaRecoveryService;
}

/**
 * How long a `STARTED` saga must be untouched before the recovery worker may take it over: it only
 * has to cover the inline attempts of a request that is still in flight.
 */
export function staleStartedGraceMs(config: OrdersConfig): number {
  return Math.max(config.upstreamTimeoutMs * config.inlineCallAttempts, config.upstreamTimeoutMs);
}

export function createOrdersRuntime(
  pool: Pool,
  config: OrdersConfig,
  overrides: OrdersRuntimeOverrides = {},
): OrdersRuntime {
  const now = overrides.now ?? (() => new Date());
  const logError = overrides.logError ?? defaultErrorLogger;

  const store = new PgOrderStore(pool, { now });
  const unitOfWork = new PgOrderUnitOfWork(pool, { now });
  const inventory =
    overrides.inventory ??
    new HttpInventoryClient({ baseUrl: config.inventoryUrl, timeoutMs: config.upstreamTimeoutMs });
  const notifications =
    overrides.notifications ??
    new HttpNotificationClient({ baseUrl: config.notificationsUrl, timeoutMs: config.upstreamTimeoutMs });

  const outbox = new OutboxDispatcher({
    store,
    notifications,
    backoffBaseMs: config.outboxBackoffBaseMs,
    now,
    logError,
  });
  const creation = new OrderCreationService({
    store,
    unitOfWork,
    inventory,
    outbox,
    inlineCallAttempts: config.inlineCallAttempts,
    now,
    logError,
  });
  const recovery = new SagaRecoveryService({
    store,
    creation,
    staleStartedGraceMs: staleStartedGraceMs(config),
    now,
    logError,
  });
  const orders = new OrderService(store);

  return {
    app: createOrdersApp({ creation, orders, logError }),
    store,
    unitOfWork,
    creation,
    outbox,
    recovery,
  };
}
