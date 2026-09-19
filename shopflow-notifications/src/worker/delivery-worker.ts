import type { NotificationDeliveryService } from '../application/notification-delivery-service.js';
import { silentLogger, type Logger } from '../observability/logger.js';

export interface DeliveryWorkerOptions {
  /** Delay between worker passes. */
  readonly intervalMs: number;
  readonly batchSize?: number;
  readonly logger?: Logger;
}

/**
 * Periodic delivery worker. The loop only exists when it is explicitly started
 * (`DELIVERY_WORKER_ENABLED=false` keeps it out of unit tests, which therefore
 * never sleep). Overlapping passes are impossible: a tick that is still running
 * makes the next tick a no-op.
 */
export class DeliveryWorker {
  private readonly delivery: NotificationDeliveryService;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(delivery: NotificationDeliveryService, options: DeliveryWorkerOptions) {
    this.delivery = delivery;
    this.intervalMs = options.intervalMs;
    this.batchSize = options.batchSize ?? 25;
    this.logger = options.logger ?? silentLogger;
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer !== null || this.stopped) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref();
    this.logger.info('notification delivery worker started', { intervalMs: this.intervalMs });
    void this.tick();
  }

  /** One worker pass; callable directly from tests (no sleeping involved). */
  async tick(): Promise<number> {
    if (this.running || this.stopped) {
      return 0;
    }
    this.running = true;
    try {
      return await this.delivery.processDueDeliveries(this.batchSize);
    } catch (error) {
      this.logger.error('notification delivery worker pass failed', { error: error instanceof Error ? error.message : String(error) });
      return 0;
    } finally {
      this.running = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}
