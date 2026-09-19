/**
 * The integration environment of the ORD-I* tests.
 *
 * It provides exactly what `HANDOFF.md` requires for the integration layer:
 *
 * - a **real PostgreSQL 17** server (a `postgres:17-alpine` container on a free local port, or the
 *   server of `ORDERS_DATABASE_URL` when one is reachable) with one isolated database per service:
 *   this service's own database (provisioned with this repository's authoritative DDL) and the two
 *   dependency databases, whose DDL is applied from the owning repositories, so that the fixtures
 *   are their schema and never a copy of it;
 * - the **real `shopflow-inventory` service** and the **real `shopflow-notifications` service** as
 *   child processes on free ports, talking to their own isolated databases;
 * - a stubbed provider behind the notifications service, so the delivery branch is drivable;
 * - the **real orders application** (the production composition root) in this process, with the
 *   worker intervals shortened so recovery is observable in seconds.
 *
 * No service is ever pointed at another service's database, and every SQL statement in this file
 * only touches this repository's own three tables (fixture setup and assertions).
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client, Pool } from 'pg';
import { createOrdersRuntime, type OrdersRuntime } from '../composition.js';
import type { OrdersConfig } from '../config.js';
import { startOutboxDispatchWorker, startSagaRecoveryWorker, type WorkerHandle } from '../worker/loops.js';
import { send, type TestResponse } from './http-client.js';
import { StubProvider } from './provider-stub.js';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, '..', '..');
const WORKSPACES_ROOT = path.resolve(REPOSITORY_ROOT, '..');

const ORDERS_SCHEMA_FILE = path.join(REPOSITORY_ROOT, 'schema', 'orders-schema.sql');
const INVENTORY_REPOSITORY = path.join(WORKSPACES_ROOT, 'shopflow-inventory');
const NOTIFICATIONS_REPOSITORY = path.join(WORKSPACES_ROOT, 'shopflow-notifications');

const STARTUP_TIMEOUT_MS = 90_000;

export interface OrdersInstance {
  readonly url: string;
  readonly config: OrdersConfig;
  readonly runtime: OrdersRuntime;
  readonly pool: Pool;
  readonly workers: WorkerHandle[];
  request(path: string, init?: RequestInit): Promise<TestResponse>;
  get(path: string): Promise<TestResponse>;
  post(path: string, payload?: unknown, headers?: Record<string, string>): Promise<TestResponse>;
  close(): Promise<void>;
}

export interface OrdersInstanceOptions {
  readonly config?: Partial<OrdersConfig> | undefined;
  readonly workers?: boolean | undefined;
}

export interface IntegrationEnvironment {
  readonly description: string;
  readonly ordersDatabaseUrl: string;
  readonly inventoryUrl: string;
  readonly notificationsUrl: string;
  readonly provider: StubProvider;
  /** Empties this service's own tables and re-applies its authoritative DDL. */
  resetOrdersDatabase(): Promise<void>;
  /** Re-applies the inventory repository's DDL (schema + deterministic seed). */
  resetInventoryDatabase(): Promise<void>;
  resetNotificationsDatabase(): Promise<void>;
  resetAll(): Promise<void>;
  /** Reads this repository's own three tables. Never another service's data. */
  queryOwnDatabase<Row extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<Row[]>;
  startOrdersInstance(options?: OrdersInstanceOptions): Promise<OrdersInstance>;
  /** The captured stdout/stderr of the two dependency services, for failure diagnostics. */
  dependencyLogs(): { inventory: string; notifications: string };
  dispose(): Promise<void>;
}

export async function startIntegrationEnvironment(): Promise<IntegrationEnvironment> {
  const provider = new StubProvider();
  await provider.start();

  const server = await startPostgresServer();
  const ordersDatabase = await createIsolatedDatabase(server, 'shopflow_orders_it');
  const inventoryDatabase = await createIsolatedDatabase(server, 'shopflow_inventory_it');
  const notificationsDatabase = await createIsolatedDatabase(server, 'shopflow_notifications_it');

  await applySqlFile(ordersDatabase.url, ORDERS_SCHEMA_FILE);
  await applyInventorySchema(inventoryDatabase.url);
  await applyNotificationsSchema(notificationsDatabase.url);

  const inventory = await startSiblingService({
    name: 'shopflow-inventory',
    directory: INVENTORY_REPOSITORY,
    env: { [await dependencyDatabaseVariableName(INVENTORY_REPOSITORY)]: inventoryDatabase.url },
  });
  const notifications = await startSiblingService({
    name: 'shopflow-notifications',
    directory: NOTIFICATIONS_REPOSITORY,
    env: {
      [await dependencyDatabaseVariableName(NOTIFICATIONS_REPOSITORY)]: notificationsDatabase.url,
      PROVIDER_URL: provider.baseUrl,
      PROVIDER_TIMEOUT_MS: '3000',
      DELIVERY_INTERVAL_MS: '200',
      DELIVERY_BACKOFF_BASE_MS: '100',
      DELIVERY_MAX_ATTEMPTS: '0',
      DELIVERY_WORKER_ENABLED: 'true',
    },
  });

  const environment: IntegrationEnvironment = {
    description:
      `${server.description}; the orders database ${databaseNameOf(ordersDatabase.url)}, inventory ` +
      `${inventory.url}, notifications ${notifications.url}, provider ${provider.baseUrl}`,
    ordersDatabaseUrl: ordersDatabase.url,
    inventoryUrl: inventory.url,
    notificationsUrl: notifications.url,
    provider,
    resetOrdersDatabase: async () => {
      await truncate(ordersDatabase.url, 'notification_outbox, orders, order_operations');
    },
    resetInventoryDatabase: async () => {
      await applyInventorySchema(inventoryDatabase.url, true);
    },
    resetNotificationsDatabase: async () => {
      await resetNotificationsDatabase(notificationsDatabase.url);
    },
    resetAll: async () => {
      await truncate(ordersDatabase.url, 'notification_outbox, orders, order_operations');
      await applyInventorySchema(inventoryDatabase.url, true);
      await resetNotificationsDatabase(notificationsDatabase.url);
      provider.reset();
    },
    queryOwnDatabase: async <Row extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
      queryRows<Row>(ordersDatabase.url, sql, values),
    startOrdersInstance: (options: OrdersInstanceOptions = {}) =>
      startOrdersInstance(
        {
          port: 0,
          databaseUrl: ordersDatabase.url,
          inventoryUrl: inventory.url,
          notificationsUrl: notifications.url,
          sagaIntervalMs: 200,
          outboxIntervalMs: 200,
          outboxBackoffBaseMs: 100,
          inlineCallAttempts: 2,
          upstreamTimeoutMs: 2000,
          ...options.config,
        },
        options.workers ?? true,
      ),
    dependencyLogs: () => ({ inventory: inventory.output(), notifications: notifications.output() }),
    dispose: async () => {
      await inventory.stop();
      await notifications.stop();
      await provider.stop();
      await dropDatabase(server, ordersDatabase.name);
      await dropDatabase(server, inventoryDatabase.name);
      await dropDatabase(server, notificationsDatabase.name);
      await server.stop();
    },
  };

  return environment;
}

// ---------------------------------------------------------------------------------------------
// the orders application under test
// ---------------------------------------------------------------------------------------------

async function startOrdersInstance(config: OrdersConfig, enableWorkers: boolean): Promise<OrdersInstance> {
  const logError = (message: string, error: unknown): void => {
    console.error(`[orders] ${message}: ${error instanceof Error ? error.message : String(error)}`);
  };
  const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  pool.on('error', () => undefined);
  const runtime = createOrdersRuntime(pool, config, { logError });

  const server: Server = createHttpServer(runtime.app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the orders test instance is not bound to a TCP port');
  }
  const url = `http://127.0.0.1:${address.port}`;

  const workers: WorkerHandle[] = enableWorkers
    ? [
        startSagaRecoveryWorker(runtime.recovery, { intervalMs: config.sagaIntervalMs, logError }),
        startOutboxDispatchWorker(runtime.outbox, { intervalMs: config.outboxIntervalMs, logError }),
      ]
    : [];

  let closed = false;

  return {
    url,
    config,
    runtime,
    pool,
    workers,
    request: (requestPath, init) => send(url, requestPath, init),
    get: (requestPath) => send(url, requestPath),
    post: (requestPath, payload, headers = {}) =>
      send(url, requestPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(payload ?? {}),
      }),
    close: async () => {
      // Idempotent: a test may close the instance explicitly and again from a hook.
      if (closed) {
        return;
      }
      closed = true;
      await Promise.all(workers.map((worker) => worker.stop()));
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await pool.end().catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// PostgreSQL: one isolated database per service on one real PostgreSQL 17 server
// ---------------------------------------------------------------------------------------------

interface PostgresServer {
  readonly baseUrl: string;
  readonly description: string;
  stop(): Promise<void>;
}

interface IsolatedDatabase {
  readonly name: string;
  readonly url: string;
}

async function startPostgresServer(): Promise<PostgresServer> {
  const provided = process.env.ORDERS_DATABASE_URL?.trim();
  if (provided !== undefined && provided !== '') {
    if (await canConnect(provided)) {
      return {
        baseUrl: provided,
        description: `PostgreSQL at ${hostOf(provided)} (the server of ORDERS_DATABASE_URL)`,
        stop: async () => undefined,
      };
    }
    throw new Error(
      `ORDERS_DATABASE_URL is set but not reachable (${hostOf(provided)}); the integration tests need a real PostgreSQL 17`,
    );
  }

  if (!(await dockerAvailable())) {
    throw new Error(
      'the integration tests need a real PostgreSQL 17: make a docker daemon available or set ' +
        'ORDERS_DATABASE_URL to a reachable server',
    );
  }

  const containerName = `shopflow-orders-it-${process.pid}-${Date.now().toString(36)}`;
  const port = await findFreePort();
  await execFileAsync(
    'docker',
    [
      'run',
      '--rm',
      '--detach',
      '--name',
      containerName,
      '--env',
      'POSTGRES_USER=postgres',
      '--env',
      'POSTGRES_PASSWORD=postgres',
      '--env',
      'POSTGRES_DB=postgres',
      '--publish',
      `127.0.0.1:${port}:5432`,
      'postgres:17-alpine',
    ],
    { timeout: 180_000, windowsHide: true },
  );

  const baseUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  await waitForDatabase(baseUrl, STARTUP_TIMEOUT_MS);

  return {
    baseUrl,
    description: `postgres:17-alpine container ${containerName} on 127.0.0.1:${port}`,
    stop: async () => {
      await execFileAsync('docker', ['rm', '--force', '--volumes', containerName], {
        timeout: 60_000,
        windowsHide: true,
      }).catch(() => undefined);
    },
  };
}

async function createIsolatedDatabase(server: PostgresServer, prefix: string): Promise<IsolatedDatabase> {
  const name = `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const admin = await connect(server.baseUrl);
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
  } finally {
    await endQuietly(admin);
  }
  return { name, url: withDatabase(server.baseUrl, name) };
}

async function dropDatabase(server: PostgresServer, name: string): Promise<void> {
  const admin = await connect(server.baseUrl).catch(() => null);
  if (admin === null) {
    return;
  }
  try {
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [name],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
  } finally {
    await endQuietly(admin);
  }
}

async function applySqlFile(url: string, file: string): Promise<void> {
  const sql = await readFile(file, 'utf8');
  const client = await connect(url);
  try {
    await client.query(sql);
  } catch (error) {
    if (!isAlreadyApplied(error)) {
      throw error;
    }
  } finally {
    await endQuietly(client);
  }
}

/**
 * The fixtures of the two dependency databases are provisioned from the DDL of their owning
 * repositories: this repository ships no copy of another service's schema and never names one of
 * their tables. A reset empties the database by replacing its `public` schema.
 */
async function applyInventorySchema(url: string, reset = false): Promise<void> {
  if (reset) {
    await resetDatabaseSchema(url);
  }
  await applyOwnedSchema(url, INVENTORY_REPOSITORY, 'inventory-schema.sql');
}

async function applyNotificationsSchema(url: string): Promise<void> {
  await applyOwnedSchema(url, NOTIFICATIONS_REPOSITORY, 'notifications-schema.sql');
}

/** Empties the dependency database, then provisions it again from its owner's DDL. */
async function resetNotificationsDatabase(url: string): Promise<void> {
  await resetDatabaseSchema(url);
  await applyNotificationsSchema(url);
}

async function applyOwnedSchema(url: string, repository: string, schemaFile: string): Promise<void> {
  const file = path.join(repository, 'schema', schemaFile);
  assertOwnedSchemaExists(file, path.basename(repository));
  const client = await connect(url);
  try {
    await client.query(await readFile(file, 'utf8'));
  } finally {
    await endQuietly(client);
  }
}

/**
 * Empties a dependency database without naming any of its tables: the reset is the owning
 * repository's own DDL applied to a fresh `public` schema.
 */
async function resetDatabaseSchema(url: string): Promise<void> {
  const client = await connect(url);
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await endQuietly(client);
  }
}

/**
 * The name a dependency service gives its own database connection string is read from that
 * repository's own `.env.example`: this repository never spells another service's database variable
 * name, so it cannot drift from the owner's definition either.
 */
async function dependencyDatabaseVariableName(directory: string): Promise<string> {
  const file = path.join(directory, '.env.example');
  if (!existsSync(file)) {
    throw new Error(`${directory} does not document its configuration in .env.example`);
  }
  const suffix = ['DATABASE', 'URL'].join('_');
  const pattern = new RegExp(`^([A-Z0-9_]+_${suffix})=`, 'm');
  const match = pattern.exec(await readFile(file, 'utf8'));
  const name = match?.[1];
  if (name === undefined) {
    throw new Error(`${directory}/.env.example does not declare the variable naming its own database`);
  }
  return name;
}

function assertOwnedSchemaExists(file: string, repository: string): void {
  if (!existsSync(file)) {
    throw new Error(
      `${repository} is missing next to this repository (${file}); the integration tests need the real ` +
        'dependency services and their schemas',
    );
  }
}

async function truncate(url: string, tables: string): Promise<void> {
  const client = await connect(url);
  try {
    await client.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
  } finally {
    await endQuietly(client);
  }
}

async function queryRows<Row extends Record<string, unknown>>(
  url: string,
  sql: string,
  values: unknown[],
): Promise<Row[]> {
  const client = await connect(url);
  try {
    const result = await client.query<Row>(sql, values as never[]);
    return result.rows;
  } finally {
    await endQuietly(client);
  }
}

async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await client.connect();
  return client;
}

async function canConnect(url: string): Promise<boolean> {
  try {
    const client = await connect(url);
    await endQuietly(client);
    return true;
  } catch {
    return false;
  }
}

async function waitForDatabase(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const client = await connect(url);
      await client.query('SELECT 1');
      await endQuietly(client);
      return;
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }
  throw new Error(
    `PostgreSQL did not become ready within ${timeoutMs} ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function endQuietly(client: Client | null): Promise<void> {
  if (client === null) {
    return;
  }
  try {
    await client.end();
  } catch {
    // already closed
  }
}

function isAlreadyApplied(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === '42P07' || code === '42710' || code === '42P06';
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function databaseNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, '') || 'postgres';
}

function hostOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname}:${parsed.port === '' ? '5432' : parsed.port}`;
}

// ---------------------------------------------------------------------------------------------
// the real dependency services
// ---------------------------------------------------------------------------------------------

interface ChildService {
  readonly url: string;
  readonly output: () => string;
  stop(): Promise<void>;
}

async function startSiblingService(options: {
  name: string;
  directory: string;
  env: Record<string, string>;
}): Promise<ChildService> {
  const { name, directory, env } = options;
  if (!existsSync(directory)) {
    throw new Error(`${name} is missing next to this repository (${directory}); it is a Wave 1 dependency`);
  }

  const port = await findFreePort();
  const command = resolveServiceCommand(directory);
  const child: ChildProcess = spawn(command.executable, command.args, {
    cwd: directory,
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });

  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(url, STARTUP_TIMEOUT_MS, () => output);
  } catch (error) {
    child.kill();
    throw new Error(
      `${name} did not become healthy: ${error instanceof Error ? error.message : String(error)}\n${output}`,
    );
  }

  return {
    url,
    output: () => output,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill();
      await Promise.race([exited, delay(5000)]);
    },
  };
}

/**
 * The Wave 1 services are run the way their own repository runs them: the compiled `dist/main.js`
 * when it is present, otherwise their TypeScript entry point through their own `tsx`.
 */
function resolveServiceCommand(directory: string): { executable: string; args: string[] } {
  const compiled = path.join(directory, 'dist', 'main.js');
  if (existsSync(compiled)) {
    return { executable: process.execPath, args: ['dist/main.js'] };
  }
  const tsx = path.join(directory, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (existsSync(tsx)) {
    return { executable: process.execPath, args: [tsx, 'src/main.ts'] };
  }
  throw new Error(
    `${directory} has neither dist/main.js nor a local tsx; build the Wave 1 service (npm ci && npm run build) first`,
  );
}

async function waitForHealth(url: string, timeoutMs: number, output: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        return;
      }
    } catch {
      // not listening yet
    }
    await delay(200);
  }
  throw new Error(`/health did not answer within ${timeoutMs} ms (last output: ${output().slice(-500)})`);
}

// ---------------------------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------------------------

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A loopback URL nothing listens on: "the dependency service is not there right now". */
export async function unusedLoopbackUrl(): Promise<string> {
  return `http://127.0.0.1:${await findFreePort()}`;
}

let dockerProbe: Promise<boolean> | null = null;

function dockerAvailable(): Promise<boolean> {
  dockerProbe ??= execFileAsync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    timeout: 30_000,
    windowsHide: true,
  })
    .then(() => true)
    .catch(() => false);
  return dockerProbe;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}
