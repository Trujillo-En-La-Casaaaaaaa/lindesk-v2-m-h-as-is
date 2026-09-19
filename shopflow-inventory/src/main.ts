import { createServer } from 'node:http';
import { Pool } from 'pg';
import { createInventoryApplication } from './composition.js';
import { loadConfig, type InventoryConfig } from './config.js';
import { errorDetail, logJson } from './logging.js';

function main(): void {
  let config: InventoryConfig;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    logJson('error', 'the inventory service cannot start', errorDetail(error));
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString: config.databaseUrl });
  pool.on('error', (error) => {
    logJson('error', 'an idle database client failed', errorDetail(error));
  });

  const app = createInventoryApplication(pool, (message, error) => logJson('error', message, errorDetail(error)));
  const server = createServer(app);

  server.listen(config.port, () => {
    logJson('info', `shopflow-inventory is listening on port ${config.port}`);
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
        void pool
          .end()
          .then(() => process.exit(0))
          .catch(() => process.exit(1));
      });
      server.closeIdleConnections();
    });
  }
}

main();
