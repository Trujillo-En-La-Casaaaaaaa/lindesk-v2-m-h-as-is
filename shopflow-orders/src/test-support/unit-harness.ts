/**
 * The unit-test harness: the production application (HTTP adapter -> application services) with the
 * persistence port and both remote ports replaced by recording doubles. No database, no network, no
 * worker timers - which is exactly what the unit layer of the handoff asks for.
 */

import type { Express } from 'express';
import { createOrdersApp } from '../adapters/http/app.js';
import { OrderService } from '../application/order-service.js';
import { OrderCreationService } from '../application/saga/order-creation-service.js';
import { OutboxDispatcher } from '../application/saga/outbox-dispatcher.js';
import { SagaRecoveryService } from '../application/saga/saga-recovery-service.js';
import { CONFIG_DEFAULTS, type OrdersConfig } from '../config.js';
import { send, type TestResponse } from './http-client.js';
import { startTestServer, type TestServer } from './http-server.js';
import { InMemoryOrderStore, InMemoryOrderUnitOfWork } from './in-memory-order-store.js';
import { RecordedInventoryClient, RecordedNotificationClient } from './recorded-clients.js';

export interface UnitHarnessOptions {
  readonly config?: Partial<OrdersConfig> | undefined;
  readonly now?: (() => Date) | undefined;
  readonly inventory?: RecordedInventoryClient | undefined;
  readonly notifications?: RecordedNotificationClient | undefined;
  readonly logError?: ((message: string, error: unknown) => void) | undefined;
}

export interface UnitHarness {
  readonly app: Express;
  readonly url: string;
  readonly store: InMemoryOrderStore;
  readonly unitOfWork: InMemoryOrderUnitOfWork;
  readonly inventory: RecordedInventoryClient;
  readonly notifications: RecordedNotificationClient;
  readonly creation: OrderCreationService;
  readonly outbox: OutboxDispatcher;
  readonly recovery: SagaRecoveryService;
  readonly config: OrdersConfig;
  post(path: string, payload: unknown, headers?: Record<string, string>): Promise<TestResponse>;
  request(path: string, init?: RequestInit): Promise<TestResponse>;
  close(): Promise<void>;
}

export function buildConfig(overrides: Partial<OrdersConfig> = {}): OrdersConfig {
  return {
    port: 0,
    databaseUrl: 'postgres://orders:orders@localhost:5432/orders',
    inventoryUrl: 'http://127.0.0.1:1',
    notificationsUrl: 'http://127.0.0.1:1',
    sagaIntervalMs: 0,
    outboxIntervalMs: 0,
    outboxBackoffBaseMs: CONFIG_DEFAULTS.outboxBackoffBaseMs,
    inlineCallAttempts: CONFIG_DEFAULTS.inlineCallAttempts,
    upstreamTimeoutMs: CONFIG_DEFAULTS.upstreamTimeoutMs,
    ...overrides,
  };
}

export async function startUnitHarness(options: UnitHarnessOptions = {}): Promise<UnitHarness> {
  const config = buildConfig(options.config);
  const now = options.now ?? (() => new Date());
  const store = new InMemoryOrderStore();
  const unitOfWork = new InMemoryOrderUnitOfWork(store);
  const inventory = options.inventory ?? new RecordedInventoryClient();
  const notifications = options.notifications ?? new RecordedNotificationClient();

  const outbox = new OutboxDispatcher({
    store,
    notifications,
    backoffBaseMs: config.outboxBackoffBaseMs,
    now,
    logError: options.logError,
  });
  const creation = new OrderCreationService({
    store,
    unitOfWork,
    inventory,
    outbox,
    inlineCallAttempts: config.inlineCallAttempts,
    inlineRetryBackoffMs: 1,
    now,
    logError: options.logError,
  });
  const recovery = new SagaRecoveryService({
    store,
    creation,
    staleStartedGraceMs: Math.max(config.upstreamTimeoutMs * config.inlineCallAttempts, 1),
    now,
    logError: options.logError,
  });
  const app = createOrdersApp({
    creation,
    orders: new OrderService(store),
    logError: options.logError,
  });
  const server: TestServer = await startTestServer(app);

  return {
    app,
    url: server.url,
    store,
    unitOfWork,
    inventory,
    notifications,
    creation,
    outbox,
    recovery,
    config,
    post: (path, payload, headers = {}) =>
      send(server.url, path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(payload ?? {}),
      }),
    request: (path, init) => send(server.url, path, init),
    close: () => server.close(),
  };
}
