import { createServer } from 'node:http';

import { loadConfig } from './config.js';
import { createLogger } from './observability/logger.js';
import { createNotificationService } from './service.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger();
  const service = createNotificationService(config, { logger });

  const server = createServer(service.app);

  await new Promise<void>((resolve) => {
    server.listen(config.port, () => {
      logger.info('shopflow-notifications listening', { port: config.port });
      resolve();
    });
  });

  await service.start();

  try {
    await service.verifyDatabase();
    logger.info('notifications-db schema verified');
  } catch (error) {
    // Keep serving: `/health` stays green, request handling reports the real error.
    logger.warn('notifications-db schema could not be verified', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info('shutting down shopflow-notifications', { signal });
    server.close(() => undefined);
    server.closeAllConnections?.();
    await service.stop();
    process.exit(0);
  };

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`shopflow-notifications failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
