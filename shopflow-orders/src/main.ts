/**
 * Entry point: configuration, pool, HTTP server and the two background loops, with a graceful
 * shutdown that stops the loops before the pool is closed.
 *
 * `npm start` runs this file from `dist/main.js` (see `package.json`).
 */

import { createServer } from 'node:http';
import { Pool } from 'pg';
import { createOrdersRuntime } from './composition.js';
import { loadConfig, type OrdersConfig } from './config.js';
import { errorDetail, logJson } from './logging.js';
import { startOutboxDispatchWorker, startSagaRecoveryWorker, type WorkerHandle } from './worker/loops.js';

function main(): void {
  let config: OrdersConfig;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    logJson('error', 'the orders service cannot start', errorDetail(error));
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString: config.databaseUrl });
  pool.on('error', (error) => {
    logJson('error', 'an idle database client failed', errorDetail(error));
  });

  const runtime = createOrdersRuntime(pool, config);
  const server = createServer(runtime.app);

  const workers: WorkerHandle[] = [
    startSagaRecoveryWorker(runtime.recovery, { intervalMs: config.sagaIntervalMs }),
    startOutboxDispatchWorker(runtime.outbox, { intervalMs: config.outboxIntervalMs }),
  ];

  server.listen(config.port, () => {
    logJson('info', `shopflow-orders is listening on port ${config.port}`);
    logJson(
      'info',
      `saga recovery every ${config.sagaIntervalMs} ms, outbox dispatch every ${config.outboxIntervalMs} ms`,
    );
  });

  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      logJson('info', `received ${signal}: shutting down`);
      server.close(() => {
        void Promise.all(workers.map((worker) => worker.stop()))
          .then(() => pool.end())
          .then(() => process.exit(0))
          .catch(() => process.exit(1));
      });
      server.closeIdleConnections();
    });
  }
}

main();
