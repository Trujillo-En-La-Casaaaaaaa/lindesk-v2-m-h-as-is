/**
 * Process entry point: reads the four environment variables, starts the HTTP edge and
 * shuts down gracefully on SIGINT/SIGTERM.
 */
import { loadConfig } from './config.js';
import { createApp } from './adapters/http/app.js';
import { activeLogger as logger } from './observability/logger.js';

const config = loadConfig();
const app = createApp({ config });

const server = app.listen(config.port, () => {
  logger.info({
    event: 'gateway_listening',
    port: config.port,
    ordersUrl: config.ordersUrl,
    inventoryUrl: config.inventoryUrl,
    upstreamTimeoutMs: config.upstreamTimeoutMs,
  });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info({ event: 'gateway_shutdown', signal });
    server.close(() => {
      process.exit(0);
    });
  });
}
