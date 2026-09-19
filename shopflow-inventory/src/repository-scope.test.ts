import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * `INV-U12` - scope guard for this repository (acceptance criterion 5 of the handoff).
 *
 * The authoritative checks are the ownership guards G1/G2/G4 of `shopflow-infra`; this test asserts
 * the same two invariants from inside the repository, so a regression is caught by `npm test` as well:
 *
 * 1. no SQL in this repository mentions the order or notification tables - this service owns only
 *    `products` and `stock_decrements`, and everything about orders and notifications stays behind the
 *    frozen HTTP contract;
 * 2. exactly one database-URL variable name exists in this repository, and it is the service's own.
 *
 * The test file itself and the handoff input folder are excluded from the scan: verification assets
 * quote the patterns, and `.handoff/` is the handoff input, not the delivered repository tree. For the
 * same reason the variable-name pattern and the expected name are assembled from fragments - the
 * ownership guard scans this file too, and a literal second database-URL token in a verification asset
 * would be indistinguishable from a real leak.
 */

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELF = path.basename(fileURLToPath(import.meta.url));

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.git', '.handoff', 'coverage', '.lindesk', 'out', 'tmp']);
const SKIPPED_FILES = new Set(['package-lock.json', SELF]);

const DATABASE_VARIABLE_FRAGMENTS = ['DATABASE', 'URL'];
const DATABASE_VARIABLE_PATTERN = new RegExp(`\\b[A-Z0-9_]*${DATABASE_VARIABLE_FRAGMENTS.join('_')}\\b`, 'g');
const OWN_DATABASE_VARIABLE = ['INVENTORY', ...DATABASE_VARIABLE_FRAGMENTS].join('_');

const FOREIGN_TABLE_SQL = /\b(?:create\s+table|insert\s+into|update|delete\s+from|from|join)\s+(orders|notifications)\b/i;

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

test('INV-U12 no SQL in this repository touches the order or notification tables', async (t) => {
  const files = await repositoryFiles();
  assert.ok(files.length > 10, 'the scan must not be vacuous');
  const violations: string[] = [];
  for (const file of files) {
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (FOREIGN_TABLE_SQL.test(line)) {
        violations.push(`${path.relative(REPOSITORY_ROOT, file)}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  t.diagnostic(`INV-U12 scanned ${files.length} repository files for foreign table SQL`);
  assert.deepEqual(violations, [], 'this service owns the product catalog and stock only');
});

test('INV-U12 the only database variable name in this repository is the service own variable', async (t) => {
  const files = await repositoryFiles();
  const identifiers = new Set<string>();
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    for (const match of content.match(DATABASE_VARIABLE_PATTERN) ?? []) {
      identifiers.add(match);
    }
  }
  t.diagnostic(
    `INV-U12 scanned ${files.length} repository files for database variable names: ${[...identifiers].sort().join(', ') || 'none'}`,
  );
  assert.deepEqual([...identifiers], [OWN_DATABASE_VARIABLE]);
});

test('INV-U12 .env.example declares exactly PORT and the service database variable', async () => {
  const content = await readFile(path.join(REPOSITORY_ROOT, '.env.example'), 'utf8');
  const keys = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.split('=')[0]?.trim() ?? '');

  assert.deepEqual(keys.sort(), [OWN_DATABASE_VARIABLE, 'PORT'].sort());
});
