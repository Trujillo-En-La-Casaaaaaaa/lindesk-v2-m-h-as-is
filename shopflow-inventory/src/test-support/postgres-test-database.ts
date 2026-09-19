import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

/**
 * Support for the integration tests: they run against a real PostgreSQL database.
 *
 * The connection string is `INVENTORY_DATABASE_URL` - the only database variable this repository may
 * contain (ownership guard G2 of `shopflow-infra`), so a second, test-specific database-URL variable
 * is deliberately absent. When the variable is unset the local default below is used, which is the
 * one documented in `.env.example` and `README.md`.
 *
 * `resetInventoryDatabase` drops the two tables and re-applies the authoritative
 * `schema/inventory-schema.sql`, so every integration test starts from the deterministic seed and the
 * delivered DDL is exercised for real.
 */

export const DEFAULT_INVENTORY_CONNECTION = 'postgres://inventory:inventory@localhost:5432/inventory';

export const INVENTORY_SCHEMA_FILE = fileURLToPath(new URL('../../schema/inventory-schema.sql', import.meta.url));

export interface TestDatabaseProbe {
  readonly available: boolean;
  readonly url: string;
  readonly reason: string;
}

export function testDatabaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.INVENTORY_DATABASE_URL;
  return configured !== undefined && configured.trim() !== '' ? configured.trim() : DEFAULT_INVENTORY_CONNECTION;
}

/** Connection string without credentials, for diagnostics. */
export function describeDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password !== '') {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return '(unparseable connection string)';
  }
}

export async function probeTestDatabase(url: string): Promise<TestDatabaseProbe> {
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5000, max: 1 });
  try {
    await pool.query('SELECT 1');
    return { available: true, url, reason: '' };
  } catch (error) {
    return { available: false, url, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/**
 * `false` when the integration tests can run, otherwise the reason to report on every skipped test.
 * A missing database is never a passing integration test: the reason states what was unreachable and
 * how to provide it, and the suite still runs the database-free unit tests.
 */
export function integrationSkipReason(probe: TestDatabaseProbe): string | false {
  if (probe.available) {
    return false;
  }
  return (
    `no PostgreSQL database reachable at ${describeDatabaseUrl(probe.url)} (${probe.reason}); ` +
    'start one with `docker run -d --name shopflow-inventory-test-db -e POSTGRES_DB=inventory ' +
    '-e POSTGRES_USER=inventory -e POSTGRES_PASSWORD=inventory -p 5432:5432 postgres:17-alpine` ' +
    'or point INVENTORY_DATABASE_URL at a running one'
  );
}

export async function resetInventoryDatabase(pool: Pool): Promise<void> {
  const schema = await readFile(INVENTORY_SCHEMA_FILE, 'utf8');
  await pool.query('DROP TABLE IF EXISTS stock_decrements, products CASCADE');
  await pool.query(schema);
}
