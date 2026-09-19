/**
 * `ORD-S1` - the scope guard of this repository (acceptance criterion 5 of the handoff).
 *
 * The authoritative checks are the ownership guards G1/G2/G4 of `shopflow-infra`; this test asserts
 * the same invariants from inside the repository, so a regression fails `npm test` as well:
 *
 * 1. no SQL statement in this repository reads or writes another service's data - this service owns
 *    `orders`, `order_operations` and `notification_outbox`, and everything about the product
 *    catalog, stock and notification records stays behind the frozen HTTP contracts;
 * 2. exactly one database-URL variable name exists in this repository, and it is the service's own;
 * 3. `.env.example` declares exactly the nine documented variables;
 * 4. the HTTP adapter registers exactly the five documented routes and no cancellation route.
 *
 * The scan skips the handoff input folder (`.handoff/` quotes the frozen contracts) and this file,
 * and its own patterns are assembled from fragments so a verification asset never contains a second
 * database-variable token of its own.
 */

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELF = path.basename(fileURLToPath(import.meta.url));

const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  '.git',
  '.handoff',
  'coverage',
  '.lindesk',
  'out',
  'tmp',
]);
const SKIPPED_FILES = new Set(['package-lock.json', SELF]);

const DATABASE_VARIABLE_FRAGMENTS = ['DATABASE', 'URL'];
const DATABASE_VARIABLE_PATTERN = new RegExp(`\\b[A-Z0-9_]*${DATABASE_VARIABLE_FRAGMENTS.join('_')}\\b`, 'g');
const OWN_DATABASE_VARIABLE = ['ORDERS', ...DATABASE_VARIABLE_FRAGMENTS].join('_');

/** The three tables this service owns. Everything else is another service's datum. */
const OWNED_TABLES = ['orders', 'order_operations', 'notification_outbox'];

/**
 * Reads or writes of a datum this service does not own. The table names are listed one per line so
 * that this verification asset never contains a foreign-datum SQL shape of its own.
 */
const FOREIGN_TABLES = [
  'products',
  'stock_decrements',
  'stock',
  'notifications',
  'notification_attempts',
];
const FOREIGN_TABLE_SQL = new RegExp(
  '\\b(?:create\\s+table|insert\\s+into|update|delete\\s+from|from|join|truncate\\s+table|' +
    `drop\\s+table|alter\\s+table)\\s+(?:[a-z_]+\\.)?(?:${FOREIGN_TABLES.join('|')})\\b`,
  'i',
);

const DOCUMENTED_ENV_VARIABLES = [
  'PORT',
  OWN_DATABASE_VARIABLE,
  'INVENTORY_URL',
  'NOTIFICATIONS_URL',
  'SAGA_INTERVAL_MS',
  'OUTBOX_INTERVAL_MS',
  'OUTBOX_BACKOFF_BASE_MS',
  'INLINE_CALL_ATTEMPTS',
  'UPSTREAM_TIMEOUT_MS',
].sort();

const DOCUMENTED_ROUTES = [
  'GET /health',
  'POST /orders',
  'GET /orders/:id',
  'POST /orders/:id/ship',
  'GET /orders/:id/operations',
].sort();

async function repositoryFiles(directory = REPOSITORY_ROOT): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      files.push(...(await repositoryFiles(absolute)));
      continue;
    }
    if (!entry.isFile() || SKIPPED_FILES.has(entry.name)) {
      continue;
    }
    files.push(absolute);
  }
  return files;
}

test('ORD-S1 no SQL in this repository touches the product, stock or notification tables', async (t) => {
  const files = await repositoryFiles();
  assert.ok(files.length > 10, 'the scan must not be vacuous');

  const violations: string[] = [];
  let statements = 0;
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    if (!/\.(?:sql|ts|js|json|md)$/i.test(file)) {
      continue;
    }
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      statements += 1;
      if (FOREIGN_TABLE_SQL.test(line)) {
        violations.push(`${path.relative(REPOSITORY_ROOT, file)}:${index + 1}: ${line.trim()}`);
      }
      // A stock column outside the inventory service's schema would be a duplicate datum.
      if (/^\s*stock\s+(?:integer|int|bigint|numeric|text|serial)/i.test(line)) {
        violations.push(`${path.relative(REPOSITORY_ROOT, file)}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  t.diagnostic(`ORD-S1 scanned ${files.length} files (${statements} lines) for foreign datum access`);
  assert.deepEqual(violations, [], `this service owns only: ${OWNED_TABLES.join(', ')}`);
});

test('ORD-S1 the only database variable name in this repository is the service own variable', async (t) => {
  const files = await repositoryFiles();
  const identifiers = new Set<string>();
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    for (const match of content.match(DATABASE_VARIABLE_PATTERN) ?? []) {
      identifiers.add(match);
    }
  }
  t.diagnostic(
    `ORD-S1 scanned ${files.length} files for database variable names: ` +
      `${[...identifiers].sort().join(', ') || 'none'}`,
  );
  assert.deepEqual([...identifiers], [OWN_DATABASE_VARIABLE]);
});

test('ORD-S1 .env.example declares exactly the nine documented variables', async () => {
  const content = await readFile(path.join(REPOSITORY_ROOT, '.env.example'), 'utf8');
  const keys = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.split('=')[0]?.trim() ?? '');

  assert.deepEqual(keys.sort(), DOCUMENTED_ENV_VARIABLES);
});

test('ORD-S1 the HTTP adapter registers exactly the five documented routes and no cancellation route', async (t) => {
  const source = await readFile(new URL('./adapters/http/app.ts', import.meta.url), 'utf8');
  const registered = [...source.matchAll(/app\.(get|post|put|patch|delete|all)\(\s*'([^']+)'/g)].map(
    (match) => `${match[1]?.toUpperCase()} ${match[2]}`,
  );

  t.diagnostic(`ORD-S1 registered routes: ${[...registered].sort().join(', ')}`);
  assert.deepEqual([...registered].sort(), DOCUMENTED_ROUTES);
  for (const route of registered) {
    assert.ok(
      !/cancel|refund|return|auth|login/i.test(route),
      `no cancellation or other invented capability may be registered (${route})`,
    );
  }
});
