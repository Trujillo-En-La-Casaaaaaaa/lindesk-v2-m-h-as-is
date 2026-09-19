import { HttpNotificationProvider } from '../adapters/provider/http-notification-provider.js';
import type { NotificationServiceConfig } from '../config.js';
import { silentLogger } from '../observability/logger.js';
import { createNotificationService, type NotificationService, type NotificationServiceOptions } from '../service.js';
import { InMemoryNotificationRepository } from './in-memory-notification-repository.js';
import { StubNotificationProvider } from './provider-stub.js';
import { startTestHttpServer, type TestHttpServer } from './test-http-server.js';

export interface UnitHarnessOptions {
  readonly providerTimeoutMs?: number;
  readonly backoffBaseMs?: number;
  readonly deliveryWorkerEnabled?: boolean;
  readonly deliveryMaxAttempts?: number;
  readonly repository?: InMemoryNotificationRepository;
  readonly serviceOptions?: NotificationServiceOptions;
}

export interface UnitHarness {
  readonly repository: InMemoryNotificationRepository;
  readonly providerStub: StubNotificationProvider;
  readonly service: NotificationService;
  readonly http: TestHttpServer;
  readonly config: NotificationServiceConfig;
  close(): Promise<void>;
}

/**
 * Unit-test wiring: the real HTTP app, the real HTTP provider adapter and the real
 * composition root, with the database replaced by the in-memory repository double
 * and the provider replaced by the in-process stub. No database, no sleeping.
 */
export async function createUnitHarness(options: UnitHarnessOptions = {}): Promise<UnitHarness> {
  const providerStub = new StubNotificationProvider();
  await providerStub.start();

  const repository = options.repository ?? new InMemoryNotificationRepository();
  const config: NotificationServiceConfig = {
    port: 0,
    // Never used: the in-memory double is injected below.
    databaseUrl: 'postgresql://in-memory-double-unused',
    providerUrl: providerStub.baseUrl,
    providerTimeoutMs: options.providerTimeoutMs ?? 3000,
    deliveryIntervalMs: 10,
    deliveryBackoffBaseMs: options.backoffBaseMs ?? 250,
    deliveryMaxAttempts: options.deliveryMaxAttempts ?? 0,
    deliveryWorkerEnabled: options.deliveryWorkerEnabled ?? false,
  };

  const service = createNotificationService(config, {
    ...options.serviceOptions,
    repository,
    provider: new HttpNotificationProvider({ baseUrl: providerStub.baseUrl, timeoutMs: config.providerTimeoutMs }),
    logger: silentLogger,
  });

  const http = await startTestHttpServer(service.app);

  return {
    repository,
    providerStub,
    service,
    http,
    config,
    close: async (): Promise<void> => {
      await http.close();
      await service.stop();
      await providerStub.stop();
    },
  };
}
