import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { promisify } from 'node:util';

import { Client } from 'pg';

const execFileAsync = promisify(execFile);

const SCHEMA_FILE = new URL('../../schema/notifications-schema.sql', import.meta.url);

/** Local default from `.env.example` (no credential is shared through this repo). */
const LOCAL_DEFAULT_URL = 'postgresql://postgres:postgres@localhost:5432/notifications';

export interface TestDatabase {
  readonly url: string;
  readonly description: string;
  /** Empties the owned tables between tests. */
  reset(): Promise<void>;
  dispose(): Promise<void>;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Plain SQL helper for assertions that reach beyond the service API. */
export async function queryRows<T extends Record<string, unknown>>(
  connectionString: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    const result = await client.query<T>(sql, params);
    return result.rows;
  } finally {
    await client.end();
  }
}

/**
 * Integration tests need a real PostgreSQL 17. Resolution order:
 *   1. `NOTIFICATIONS_DATABASE_URL` - an isolated database is created on that
 *      server (the provided database itself is left untouched);
 *   2. otherwise a `postgres:17-alpine` container on a free local port;
 *   3. otherwise the local default server from `.env.example`.
 * Never a fake database and never a skipped test: when none of these work the
 * suite fails with the reason.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const provided = process.env.NOTIFICATIONS_DATABASE_URL?.trim();

  if (provided !== undefined && provided !== '') {
    const isolated = await tryIsolatedDatabase(provided, 'NOTIFICATIONS_DATABASE_URL');
    if (isolated !== null) {
      return isolated;
    }
    const direct = await tryProvidedDatabase(provided);
    if (direct !== null) {
      return direct;
    }
    throw new Error(`NOTIFICATIONS_DATABASE_URL is set but unusable for integration tests: ${provided}`);
  }

  const container = await tryContainerDatabase();
  if (container !== null) {
    return container;
  }

  const fallback = await tryIsolatedDatabase(LOCAL_DEFAULT_URL, 'local default server');
  if (fallback !== null) {
    return fallback;
  }

  throw new Error(
    'integration tests need a real PostgreSQL 17: set NOTIFICATIONS_DATABASE_URL to a reachable database or make a docker daemon available',
  );
}

async function tryIsolatedDatabase(baseUrl: string, origin: string): Promise<TestDatabase | null> {
  const databaseName = `notifications_it_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  let admin: Client | null = null;
  try {
    admin = await connect(baseUrl, 'postgres');
    const version = await serverVersion(admin);
    if (!version.startsWith('17')) {
      console.warn(`[integration] PostgreSQL ${version} detected at ${hostOf(baseUrl)} (PostgreSQL 17 is the target runtime)`);
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  } catch (error) {
    await endQuietly(admin);
    console.warn(`[integration] could not create an isolated database from ${origin}: ${messageOf(error)}`);
    return null;
  }
  await endQuietly(admin);

  const url = withDatabase(baseUrl, databaseName);
  try {
    await applySchema(url);
  } catch (error) {
    await dropDatabase(baseUrl, databaseName);
    throw error;
  }

  return {
    url,
    description: `isolated PostgreSQL database ${databaseName} on ${hostOf(baseUrl)} (from ${origin})`,
    reset: () => truncateOwnedTables(url),
    dispose: () => dropDatabase(baseUrl, databaseName),
  };
}

async function tryProvidedDatabase(url: string): Promise<TestDatabase | null> {
  try {
    await applySchema(url);
    const admin = await connect(url);
    try {
      const version = await serverVersion(admin);
      return {
        url,
        description: `provided database ${databaseNameOf(url)} (PostgreSQL ${version})`,
        reset: () => truncateOwnedTables(url),
        dispose: async () => undefined,
      };
    } finally {
      await endQuietly(admin);
    }
  } catch (error) {
    console.warn(`[integration] NOTIFICATIONS_DATABASE_URL is not usable: ${messageOf(error)}`);
    return null;
  }
}

async function tryContainerDatabase(): Promise<TestDatabase | null> {
  if (!(await dockerAvailable())) {
    return null;
  }

  const containerName = `shopflow-notifications-it-${process.pid}-${Date.now().toString(36)}`;
  const port = await findFreePort();
  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/notifications`;

  try {
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
        'POSTGRES_DB=notifications',
        '--publish',
        `127.0.0.1:${port}:5432`,
        'postgres:17-alpine',
      ],
      { timeout: 180_000, windowsHide: true },
    );
  } catch (error) {
    console.warn(`[integration] could not start a postgres:17-alpine container: ${messageOf(error)}`);
    return null;
  }

  try {
    await waitForServer(url, 90_000);
    await applySchema(url);
  } catch (error) {
    await removeContainer(containerName);
    throw error;
  }

  return {
    url,
    description: `postgres:17-alpine container ${containerName} on 127.0.0.1:${port}`,
    reset: () => truncateOwnedTables(url),
    dispose: () => removeContainer(containerName),
  };
}

async function applySchema(url: string): Promise<void> {
  const sql = await readFile(SCHEMA_FILE, 'utf8');
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

async function truncateOwnedTables(url: string): Promise<void> {
  const client = await connect(url);
  try {
    await client.query('TRUNCATE TABLE notification_attempts, notifications RESTART IDENTITY CASCADE');
  } finally {
    await endQuietly(client);
  }
}

async function dropDatabase(baseUrl: string, databaseName: string): Promise<void> {
  const admin = await connect(baseUrl, 'postgres');
  try {
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [
      databaseName,
    ]);
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
  } finally {
    await endQuietly(admin);
  }
}

async function removeContainer(containerName: string): Promise<void> {
  try {
    await execFileAsync('docker', ['rm', '--force', '--volumes', containerName], { timeout: 60_000, windowsHide: true });
  } catch {
    // The container is already gone (or was never created).
  }
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    let client: Client | null = null;
    try {
      client = await connect(url);
      await client.query('SELECT 1');
      await endQuietly(client);
      return;
    } catch (error) {
      lastError = error;
      await endQuietly(client);
      await delay(500);
    }
  }
  throw new Error(`PostgreSQL did not become ready within ${timeoutMs} ms: ${messageOf(lastError)}`);
}

async function connect(url: string, database?: string): Promise<Client> {
  const client = new Client({
    connectionString: database === undefined ? url : withDatabase(url, database),
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  return client;
}

async function serverVersion(client: Client): Promise<string> {
  const result = await client.query<{ server_version: string }>('SHOW server_version');
  return result.rows[0]?.server_version ?? 'unknown';
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let dockerProbe: Promise<boolean> | null = null;

function dockerAvailable(): Promise<boolean> {
  dockerProbe ??= execFileAsync('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 20_000, windowsHide: true })
    .then(() => true)
    .catch(() => false);
  return dockerProbe;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}
