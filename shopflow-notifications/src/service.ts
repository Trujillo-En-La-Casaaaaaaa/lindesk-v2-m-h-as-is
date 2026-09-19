import type { Express } from 'express';

import { createNotificationApp } from './adapters/http/app.js';
import { PostgresNotificationRepository } from './adapters/postgres/notification-repository.js';
import { HttpNotificationProvider } from './adapters/provider/http-notification-provider.js';
import { NotificationDeliveryService } from './application/notification-delivery-service.js';
import type { NotificationServiceConfig } from './config.js';
import { silentLogger, type Logger } from './observability/logger.js';
import type { NotificationProvider } from './ports/notification-provider.js';
import type { NotificationRepository } from './ports/notification-repository.js';
import { DeliveryWorker } from './worker/delivery-worker.js';

export interface NotificationServiceOptions {
  readonly repository?: NotificationRepository;
  readonly provider?: NotificationProvider;
  readonly logger?: Logger;
}

export interface NotificationService {
  readonly config: NotificationServiceConfig;
  readonly app: Express;
  readonly repository: NotificationRepository;
  readonly provider: NotificationProvider;
  readonly delivery: NotificationDeliveryService;
  /** `null` when `DELIVERY_WORKER_ENABLED=false`. */
  readonly worker: DeliveryWorker | null;
  start(): Promise<void>;
  verifyDatabase(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Composition root: wires the HTTP adapter, the delivery service, the delivery
 * worker and the adapters for `notifications-db` and the external provider.
 */
export function createNotificationService(
  config: NotificationServiceConfig,
  options: NotificationServiceOptions = {},
): NotificationService {
  const logger = options.logger ?? silentLogger;
  const repository =
    options.repository ??
    new PostgresNotificationRepository({
      connectionString: config.databaseUrl,
      logger,
    });
  const provider =
    options.provider ??
    new HttpNotificationProvider({
      baseUrl: config.providerUrl,
      timeoutMs: config.providerTimeoutMs,
    });

  const delivery = new NotificationDeliveryService({
    repository,
    provider,
    backoffBaseMs: config.deliveryBackoffBaseMs,
    maxAttempts: config.deliveryMaxAttempts,
    logger,
  });

  const app = createNotificationApp({ repository, delivery, logger });

  const worker = config.deliveryWorkerEnabled
    ? new DeliveryWorker(delivery, { intervalMs: config.deliveryIntervalMs, logger })
    : null;

  let started = false;
  let stopped = false;

  return {
    config,
    app,
    repository,
    provider,
    delivery,
    worker,
    async start(): Promise<void> {
      if (stopped) {
        throw new Error('notification service has already been stopped');
      }
      if (started) {
        return;
      }
      started = true;
      worker?.start();
      logger.info('notification service started', {
        deliveryWorkerEnabled: worker !== null,
        deliveryIntervalMs: config.deliveryIntervalMs,
      });
    },
    async verifyDatabase(): Promise<void> {
      if (repository instanceof PostgresNotificationRepository) {
        await repository.verifySchema();
      }
    },
    async stop(): Promise<void> {
      stopped = true;
      await worker?.stop();
      await repository.close();
      logger.info('notification service stopped');
    },
  };
}
