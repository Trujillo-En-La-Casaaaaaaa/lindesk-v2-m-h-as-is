/**
 * Test harness: two local upstream stubs plus the real gateway application under test.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { createApp } from '../adapters/http/app.js';
import type { GatewayConfig } from '../config.js';
import { createCapturingLogger, type CapturingLogger } from '../observability/logger.js';
import { ORDER_ID, PRODUCTS_BODY, createdOrderBody, shippedOrderBody } from './legacy-fixtures.js';
import {
  closeServer,
  startStubServer,
  type RecordedRequest,
  type StubResponder,
  type StubResponse,
  type StubServer,
} from './upstream-stub.js';

export interface HarnessOptions {
  readonly inventoryResponder?: StubResponder;
  readonly ordersResponder?: StubResponder;
  readonly inventoryUrl?: string;
  readonly ordersUrl?: string;
  readonly upstreamTimeoutMs?: number;
}

export interface Harness {
  readonly gatewayUrl: string;
  readonly inventory: StubServer;
  readonly orders: StubServer;
  readonly logger: CapturingLogger;
  readonly config: GatewayConfig;
  close(): Promise<void>;
}

function defaultOrdersResponder(request: RecordedRequest): StubResponse {
  if (request.method === 'GET') {
    return { status: 200, body: createdOrderBody() };
  }
  if (request.url === `/orders/${ORDER_ID}/ship`) {
    return { status: 200, body: shippedOrderBody() };
  }
  return { status: 201, body: createdOrderBody() };
}

function listenApp(app: Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
    server.once('error', reject);
  });
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const inventory = await startStubServer(
    options.inventoryResponder ?? (() => ({ status: 200, body: PRODUCTS_BODY })),
  );
  const orders = await startStubServer(options.ordersResponder ?? defaultOrdersResponder);
  const logger = createCapturingLogger();
  const config: GatewayConfig = {
    port: 0,
    ordersUrl: options.ordersUrl ?? orders.url,
    inventoryUrl: options.inventoryUrl ?? inventory.url,
    upstreamTimeoutMs: options.upstreamTimeoutMs ?? 5000,
  };
  const { server, port } = await listenApp(createApp({ config, logger }));

  return {
    gatewayUrl: `http://127.0.0.1:${port}`,
    inventory,
    orders,
    logger,
    config,
    async close() {
      await closeServer(server);
      await inventory.close();
      await orders.close();
    },
  };
}

export async function withHarness<T>(
  options: HarnessOptions,
  run: (harness: Harness) => Promise<T>,
): Promise<T> {
  const harness = await startHarness(options);
  try {
    return await run(harness);
  } finally {
    await harness.close();
  }
}
