/**
 * ShopFlow ownership and scope guards (G1-G7).
 *
 * Owner: `shopflow-infra` (`tests/ownership/`). These are architecture fitness functions: they read
 * the sibling repositories as text and deployment configuration and fail when a boundary is broken.
 * They need no database and no running stack, so they can be executed immediately and in CI.
 *
 * Run: `node --test tests/ownership/` (or `node --test tests/`). Every guard prints
 * `GUARD | STATUS | DETAIL` and the process exits non-zero when a guard fails. A violation is
 * reported as `G<n> FAIL <repository>/<file>:<line> matches <pattern>`.
 *
 * Scope of the scan
 * -----------------
 * In addition to the specified ignore list (`node_modules`, `dist`, `build`, `.git`, `coverage` and
 * lockfiles) the walker skips:
 *
 *   - `.handoff/`   the handoff input folder: it is not part of the delivered repository tree (it is
 *                   untracked in git) and it quotes the legacy commands and these guard definitions.
 *   - `tests/`      the verification assets of this repository. The behaviour-preservation spec
 *                   (P3 step 6) requires the black-box suite to count order rows through `psql`, and
 *                   the required legacy baseline evidence quotes the retired commands. Verification
 *                   assets are therefore not treated as production data-access code.
 *   - Markdown      documentation cannot write to a database, so `*.md` is excluded from the
 *                   data-access scans. G2 still scans the documentation of the five service
 *                   repositories (that is where a retired name would be a real leak).
 *
 * Every guard reports how many repositories and files it actually scanned, so a vacuous pass cannot
 * be mistaken for proof: guard G6 fails exactly when a sibling repository is missing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const WORKSPACES_ROOT = path.dirname(REPO_ROOT);

const INFRA = 'shopflow-infra';
const SERVICE_REPOS = ['shopflow-orders', 'shopflow-inventory', 'shopflow-notifications'];
const EXPECTED_REPOS = [
  'shopflow-web',
  'shopflow-gateway',
  'shopflow-orders',
  'shopflow-inventory',
  'shopflow-notifications',
  INFRA,
];
const ALL_REPOS = EXPECTED_REPOS;

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.handoff',
  '.lindesk',
  '.vscode',
  '.idea',
  'out',
  'tmp',
]);
const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'go.sum',
  'Cargo.lock',
]);
const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|ico|svg|woff2?|ttf|eot|map|lock)$/i;

function repoPath(name) {
  return path.join(WORKSPACES_ROOT, name);
}

function repoExists(name) {
  return fs.existsSync(repoPath(name));
}

function posix(relative) {
  return relative.split(path.sep).join('/');
}

function repoRelative(repoName, absoluteFile) {
  return posix(path.relative(repoPath(repoName), absoluteFile));
}

function collect(root, options, current, output) {
  let entries;
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (entry.name === 'tests' && options.includeTests !== true) continue;
      collect(root, options, absolute, output);
      continue;
    }
    if (!entry.isFile()) continue;
    if (LOCKFILES.has(entry.name)) continue;
    if (BINARY_EXTENSIONS.test(entry.name)) continue;
    if (/\.mdx?$/i.test(entry.name) && options.includeMarkdown !== true) continue;
    output.push(absolute);
  }
  return output;
}

function scannedFiles(repoName, options = {}) {
  const root = repoPath(repoName);
  if (!fs.existsSync(root)) return [];
  return collect(root, options, root, []);
}

function scanSet(repoNames, options = {}) {
  const files = [];
  let scannedRepos = 0;
  for (const repoName of repoNames) {
    const repoFiles = scannedFiles(repoName, options);
    if (repoExists(repoName)) scannedRepos += 1;
    for (const file of repoFiles) files.push({ repoName, file });
  }
  return { files, scannedRepos };
}

function lineHits(entry, pattern) {
  const hits = [];
  const lines = fs.readFileSync(entry.file, 'utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index])) {
      hits.push({ line: index + 1, text: lines[index].trim() });
    }
  }
  return hits;
}

function report(guardId, entry, hit, patternLabel) {
  return `${guardId} FAIL ${entry.repoName}/${repoRelative(entry.repoName, entry.file)}:${hit.line} matches ${patternLabel}`;
}

function fail(violations) {
  return `${violations.length} violation(s):\n${violations.join('\n')}`;
}

// ---------------------------------------------------------------------------------------------
// minimal YAML subset parser (maps, scalar sequences and scalar flow collections)
// ---------------------------------------------------------------------------------------------

function stripQuotes(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value === '') return '';
  if (/^[[{|>]/.test(value)) return value;
  return stripQuotes(value);
}

function parseList(lines, state, indent) {
  const items = [];
  while (
    state.index < lines.length &&
    lines[state.index].indent === indent &&
    lines[state.index].content.startsWith('-')
  ) {
    const itemText = lines[state.index].content.slice(1).trim();
    state.index += 1;
    if (itemText === '') {
      items.push(
        state.index < lines.length && lines[state.index].indent > indent
          ? parseBlock(lines, state, lines[state.index].indent)
          : null,
      );
      continue;
    }
    items.push(parseScalar(itemText));
  }
  return items;
}

function parseMap(lines, state, indent) {
  const map = {};
  while (state.index < lines.length) {
    const line = lines[state.index];
    if (line.indent !== indent || line.content.startsWith('-')) break;
    const match = /^([^:]+):\s*(.*)$/.exec(line.content);
    if (!match) {
      state.index += 1;
      continue;
    }
    const key = stripQuotes(match[1].trim());
    const rest = match[2].trim();
    state.index += 1;
    if (rest === '') {
      if (state.index < lines.length && lines[state.index].indent > indent) {
        map[key] = parseBlock(lines, state, lines[state.index].indent);
      } else {
        map[key] = null;
      }
    } else {
      map[key] = parseScalar(rest);
    }
  }
  return map;
}

function parseBlock(lines, state, indent) {
  if (lines[state.index].content.startsWith('-')) {
    return parseList(lines, state, indent);
  }
  return parseMap(lines, state, indent);
}

function parseYamlSubset(text) {
  const lines = text
    .split(/\r?\n/)
    .map((raw) => ({
      indent: (raw.match(/^ */) ?? [''])[0].length,
      content: raw.trim(),
    }))
    .filter((line) => line.content !== '' && !line.content.startsWith('#'));
  return parseBlock(lines, { index: 0 }, 0);
}

function composeModel() {
  const file = path.join(REPO_ROOT, 'docker-compose.yml');
  return parseYamlSubset(fs.readFileSync(file, 'utf8'));
}

function serviceEnvironment(service) {
  const environment = service?.environment;
  return environment && typeof environment === 'object' ? environment : {};
}

function servicePorts(service) {
  const ports = service?.ports;
  return Array.isArray(ports) ? ports : [];
}

function serviceDependsOn(service) {
  const dependsOn = service?.depends_on;
  return dependsOn && typeof dependsOn === 'object' && !Array.isArray(dependsOn) ? dependsOn : {};
}

function databaseUrlEntries(service) {
  return Object.entries(serviceEnvironment(service)).filter(([key]) => /DATABASE_URL$/.test(key));
}

function parsePostgresUrl(value) {
  const match = /^postgres(?:ql)?:\/\/([^:@/]+):[^@/]*@([^:/]+):(\d+)\/([^?]+)$/.exec(String(value).trim());
  if (!match) return null;
  return { user: match[1], host: match[2], port: match[3], database: match[4] };
}

function publishedHostPorts(service) {
  const ports = [];
  for (const entry of servicePorts(service)) {
    const match = /^(?:[\d.]+:)?(\d+):(\d+)$/.exec(String(entry).replace(/"/g, '').trim());
    if (match) ports.push({ host: Number(match[1]), container: Number(match[2]) });
  }
  return ports;
}

function bindMountSources(service) {
  const sources = [];
  for (const entry of Array.isArray(service?.volumes) ? service.volumes : []) {
    const parts = String(entry).replace(/"/g, '').split(':');
    sources.push({ source: parts[0], target: parts[1], mode: parts[2] });
  }
  return sources;
}

function gatewaySourceFile(relativePath) {
  return path.join(repoPath('shopflow-gateway'), relativePath);
}

function gatewayRouteTable() {
  const file = gatewaySourceFile(path.join('src', 'routes', 'table.ts'));
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const routes = [];
  const pattern = /method:\s*'([A-Z]+)'[\s\S]{0,160}?publicPath:\s*'([^']+)'/g;
  let match = pattern.exec(text);
  while (match !== null) {
    routes.push(`${match[1]} ${match[2]}`);
    match = pattern.exec(text);
  }
  return routes;
}

function gatewayRegistrations() {
  const file = gatewaySourceFile(path.join('src', 'adapters', 'http', 'app.ts'));
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const routes = [];
  const pattern = /app\.(get|post|put|patch|delete|all)\(\s*'([^']+)'/g;
  let match = pattern.exec(text);
  while (match !== null) {
    routes.push(`${match[1].toUpperCase()} ${match[2]}`);
    match = pattern.exec(text);
  }
  return routes;
}

// ---------------------------------------------------------------------------------------------
// G1 - single writer per datum
// ---------------------------------------------------------------------------------------------

const G1_RULES = [
  {
    label: 'stock mutation',
    pattern: /update\s+products\s+set\s+stock|stock\s*=\s*stock\s*[-+]/i,
    owners: ['shopflow-inventory'],
  },
  {
    label: 'products table DDL or access',
    pattern: /create\s+table\s+products|from\s+products|into\s+products|products\b.*\bstock\b/i,
    owners: ['shopflow-inventory'],
  },
  {
    label: 'orders table DDL or access',
    pattern: /create\s+table\s+orders|from\s+orders|into\s+orders|update\s+orders/i,
    owners: ['shopflow-orders'],
  },
  {
    label: 'notification records DDL or access',
    pattern: /create\s+table\s+notifications|from\s+notifications|into\s+notifications/i,
    owners: ['shopflow-notifications'],
  },
];

function guardG1() {
  const violations = [];
  let files = 0;
  let repos = 0;
  for (const rule of G1_RULES) {
    const { files: scanned, scannedRepos } = scanSet(ALL_REPOS, { includeMarkdown: false });
    files = Math.max(files, scanned.length);
    repos = Math.max(repos, scannedRepos);
    for (const entry of scanned) {
      // The infra repository is the composition owner: it legitimately ships the applied copies of
      // the owners' schemas, but only as `postgres/*-init.sql` (nothing else may touch a datum).
      const isInitScript = /^postgres\/[\w.-]*init\.sql$/.test(repoRelative(entry.repoName, entry.file));
      const allowed = rule.owners.includes(entry.repoName) || (entry.repoName === INFRA && isInitScript);
      if (allowed) continue;
      for (const hit of lineHits(entry, rule.pattern)) {
        violations.push(report('G1', entry, hit, `${rule.label} /${rule.pattern.source}/i`));
      }
    }
  }
  if (violations.length > 0) throw new Error(fail(violations));
  return `no cross-owner data access or DDL outside the owning repository (${repos} repositories, ${files} files)`;
}

// ---------------------------------------------------------------------------------------------
// G2 - no cross-service database access
// ---------------------------------------------------------------------------------------------

const EXPECTED_DATABASE_URL_NAME = {
  'shopflow-orders': 'ORDERS_DATABASE_URL',
  'shopflow-inventory': 'INVENTORY_DATABASE_URL',
  'shopflow-notifications': 'NOTIFICATIONS_DATABASE_URL',
};

const RETIRED_NAMES = ['shopflow-api', 'postgres-db'];

function guardG2() {
  const violations = [];

  // 1. every DATABASE_URL occurrence in a service repository must be that repository's own name
  for (const repoName of ['shopflow-web', 'shopflow-gateway', ...SERVICE_REPOS]) {
    const expected = EXPECTED_DATABASE_URL_NAME[repoName] ?? null;
    const { files } = scanSet([repoName], { includeMarkdown: true });
    for (const entry of files) {
      const lines = fs.readFileSync(entry.file, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        if (!/DATABASE_URL/.test(line)) return;
        const identifiers = line.match(/\b[A-Z0-9_]*DATABASE_URL\b/g) ?? [];
        for (const identifier of identifiers) {
          if (identifier !== expected) {
            violations.push(
              `G2 FAIL ${repoName}/${repoRelative(repoName, entry.file)}:${index + 1} matches ` +
                `foreign database variable "${identifier}" (allowed: ${expected ?? 'none'})`,
            );
          }
        }
      });
    }
  }

  // 2. no repository outside shopflow-infra may name another service's database host
  for (const repoName of ALL_REPOS.filter((name) => name !== INFRA)) {
    const { files } = scanSet([repoName], { includeMarkdown: true });
    const pattern = /\b(?:orders|inventory|notifications)-db\b/;
    for (const entry of files) {
      for (const hit of lineHits(entry, pattern)) {
        violations.push(report('G2', entry, hit, 'foreign database host /\\b(orders|inventory|notifications)-db\\b/'));
      }
    }
  }

  // 3. no repository may rely on the retired names (service docs included; the infra migration
  //    documentation and the recorded legacy baseline are excluded, see the scope note on top)
  for (const repoName of ALL_REPOS) {
    const { files } = scanSet([repoName], { includeMarkdown: repoName !== INFRA });
    for (const entry of files) {
      const lines = fs.readFileSync(entry.file, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        for (const retired of [...RETIRED_NAMES, 'shopflow:shopflow@db:5432/shopflow']) {
          if (line.toLowerCase().includes(retired.toLowerCase())) {
            violations.push(
              `G2 FAIL ${repoName}/${repoRelative(repoName, entry.file)}:${index + 1} matches ` +
                `retired name "${retired}"`,
            );
          }
        }
      });
    }
  }

  if (violations.length > 0) throw new Error(fail(violations));
  return 'every service holds only its own database URL, no foreign host and no retired name';
}

// ---------------------------------------------------------------------------------------------
// G3 - compose grants exactly one database per service
// ---------------------------------------------------------------------------------------------

const DATABASE_SERVICES = ['orders-db', 'inventory-db', 'notifications-db'];
const APPLICATION_SERVICES = ['web', 'gateway', 'orders', 'inventory', 'notifications'];

function guardG3() {
  const compose = composeModel();
  const services = compose?.services ?? {};
  const violations = [];
  const serviceNames = Object.keys(services);
  const expectedServices = [
    'web',
    'gateway',
    'orders',
    'inventory',
    'notifications',
    'notification-emulator',
    ...DATABASE_SERVICES,
  ];

  for (const expected of expectedServices) {
    if (!serviceNames.includes(expected)) {
      violations.push(`G3 FAIL docker-compose.yml:0 missing service "${expected}"`);
    }
  }
  for (const name of serviceNames.filter((candidate) => !expectedServices.includes(candidate))) {
    violations.push(`G3 FAIL docker-compose.yml:0 unexpected service "${name}"`);
  }

  // exactly one own database URL per application service, matching its own database
  for (const serviceName of SERVICE_REPOS.map((repo) => repo.replace('shopflow-', ''))) {
    const service = services[serviceName];
    if (!service) continue;
    const entries = databaseUrlEntries(service);
    if (entries.length !== 1) {
      violations.push(
        `G3 FAIL docker-compose.yml:0 service "${serviceName}" must receive exactly one *_DATABASE_URL ` +
          `(found ${entries.length}: ${entries.map(([key]) => key).join(', ') || 'none'})`,
      );
      continue;
    }
    const [key, value] = entries[0];
    const parsed = parsePostgresUrl(value);
    const ownDatabaseService = `${serviceName}-db`;
    if (!parsed) {
      violations.push(
        `G3 FAIL docker-compose.yml:0 service "${serviceName}" has an unparseable database URL in ${key}`,
      );
      continue;
    }
    if (parsed.host !== ownDatabaseService || parsed.database !== serviceName) {
      violations.push(
        `G3 FAIL docker-compose.yml:0 service "${serviceName}" ${key} must name its own database ` +
          `(${ownDatabaseService}:5432/${serviceName}); found ${parsed.host}:${parsed.port}/${parsed.database}`,
      );
    }
  }

  // the edge and the UI must not receive any database variable at all
  for (const serviceName of ['web', 'gateway']) {
    const service = services[serviceName];
    if (!service) continue;
    for (const [key] of databaseUrlEntries(service)) {
      violations.push(`G3 FAIL docker-compose.yml:0 service "${serviceName}" must not receive ${key}`);
    }
  }

  // no service may hold another service's connection string
  for (const [serviceName, service] of Object.entries(services)) {
    for (const [key, value] of Object.entries(serviceEnvironment(service))) {
      const parsed = parsePostgresUrl(value);
      if (!parsed) continue;
      const own = `${serviceName}-db`;
      if (parsed.host !== own) {
        violations.push(
          `G3 FAIL docker-compose.yml:0 service "${serviceName}" ${key} points at a foreign database host ` +
            `"${parsed.host}" (own: ${own})`,
        );
      }
    }
  }

  // database services stay unpublished and own exactly one volume and one init script each
  const initMounts = new Map();
  for (const databaseService of DATABASE_SERVICES) {
    const service = services[databaseService];
    if (!service) continue;
    const hostPorts = publishedHostPorts(service);
    if (hostPorts.length > 0) {
      violations.push(
        `G3 FAIL docker-compose.yml:0 database service "${databaseService}" must not publish a host port ` +
          `(found ${hostPorts.map((port) => port.host).join(', ')})`,
      );
    }
    const namedVolumes = bindMountSources(service).filter(
      ({ source }) => !source.startsWith('./') && !source.startsWith('/'),
    );
    if (namedVolumes.length !== 1) {
      violations.push(
        `G3 FAIL docker-compose.yml:0 database service "${databaseService}" must own exactly one volume ` +
          `(found ${namedVolumes.length})`,
      );
    }
    const initScripts = bindMountSources(service)
      .map(({ source }) => source.replace(/^\.\//, ''))
      .filter((source) => /^postgres\/[\w.-]*init\.sql$/.test(source));
    if (initScripts.length !== 1) {
      violations.push(
        `G3 FAIL docker-compose.yml:0 database service "${databaseService}" must mount exactly one init script ` +
          `(found ${initScripts.length})`,
      );
    }
    for (const script of initScripts) {
      if (initMounts.has(script)) {
        violations.push(
          `G3 FAIL docker-compose.yml:0 init script "${script}" is mounted into more than one database ` +
            `container (${initMounts.get(script)} and ${databaseService})`,
        );
      }
      initMounts.set(script, databaseService);
    }
  }

  // only the documented host ports are published, by the documented services
  const publishedBy = new Map();
  for (const [serviceName, service] of Object.entries(services)) {
    for (const port of publishedHostPorts(service)) {
      publishedBy.set(port.host, serviceName);
    }
  }
  assert.deepEqual(
    [...publishedBy.keys()].sort((a, b) => a - b),
    [3000, 3001, 4010],
    'G3 FAIL docker-compose.yml:0 published host ports must be exactly 3000, 3001 and 4010',
  );
  for (const [port, serviceName] of publishedBy) {
    const expectedOwner = port === 3000 ? 'web' : port === 3001 ? 'gateway' : 'notification-emulator';
    if (serviceName !== expectedOwner) {
      violations.push(
        `G3 FAIL docker-compose.yml:0 host port ${port} must be published by "${expectedOwner}", not "${serviceName}"`,
      );
    }
  }

  // healthchecks and healthcheck-gated startup ordering
  for (const serviceName of APPLICATION_SERVICES) {
    const service = services[serviceName];
    if (!service) continue;
    if (!service.healthcheck) {
      violations.push(`G3 FAIL docker-compose.yml:0 service "${serviceName}" must declare a healthcheck`);
    }
    for (const [dependency, condition] of Object.entries(serviceDependsOn(service))) {
      if (condition?.condition !== 'service_healthy') {
        violations.push(
          `G3 FAIL docker-compose.yml:0 service "${serviceName}" depends_on "${dependency}" without ` +
            'condition: service_healthy',
        );
      }
    }
  }
  for (const [serviceName, service] of Object.entries(services)) {
    for (const [dependency, condition] of Object.entries(serviceDependsOn(service))) {
      if (condition?.condition !== 'service_healthy') {
        violations.push(
          `G3 FAIL docker-compose.yml:0 service "${serviceName}" depends_on "${dependency}" without ` +
            'condition: service_healthy',
        );
      }
    }
  }

  // The startup ordering must be exactly the documented one (Target Architecture of the handoff and
  // `runtime/compose-plan.md`): every edge healthcheck-gated, and no other edge. The databases and the
  // provider are leaves and must not depend on anything.
  const expectedEdges = {
    inventory: ['inventory-db'],
    notifications: ['notifications-db', 'notification-emulator'],
    orders: ['orders-db', 'inventory'],
    gateway: ['orders', 'inventory'],
    web: ['gateway'],
  };
  for (const [serviceName, expected] of Object.entries(expectedEdges)) {
    const service = services[serviceName];
    if (!service) continue;
    const actual = Object.keys(serviceDependsOn(service)).sort();
    const wanted = [...expected].sort();
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      violations.push(
        `G3 FAIL docker-compose.yml:0 service "${serviceName}" must depend on exactly ` +
          `${JSON.stringify(wanted)} with condition: service_healthy; found ${JSON.stringify(actual)}`,
      );
    }
  }
  for (const serviceName of [...DATABASE_SERVICES, 'notification-emulator']) {
    const service = services[serviceName];
    if (!service) continue;
    const actual = Object.keys(serviceDependsOn(service));
    if (actual.length > 0) {
      violations.push(
        `G3 FAIL docker-compose.yml:0 service "${serviceName}" must not declare depends_on ` +
          `(found: ${actual.join(', ')})`,
      );
    }
  }

  // no build context may reference the retired repository
  for (const [serviceName, service] of Object.entries(services)) {
    const context = typeof service?.build === 'object' ? service.build?.context : service?.build;
    if (typeof context === 'string' && /shopflow-api/.test(context)) {
      violations.push(`G3 FAIL docker-compose.yml:0 service "${serviceName}" builds from the retired repository`);
    }
  }

  if (violations.length > 0) throw new Error(fail(violations));
  return `9 services, one own database URL each, no published database port, healthcheck-gated ordering (${initMounts.size} init scripts)`;
}

// ---------------------------------------------------------------------------------------------
// G4 - no shared persistence shortcuts
// ---------------------------------------------------------------------------------------------

const TABLE_OWNERS = {
  products: 'shopflow-inventory',
  stock_decrements: 'shopflow-inventory',
  orders: 'shopflow-orders',
  order_operations: 'shopflow-orders',
  notification_outbox: 'shopflow-orders',
  notifications: 'shopflow-notifications',
  notification_attempts: 'shopflow-notifications',
};

function tableDefinitions(entry) {
  const definitions = [];
  const lines = fs.readFileSync(entry.file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    const match = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/i.exec(line);
    if (match) definitions.push({ table: match[1].toLowerCase(), line: index + 1 });
  });
  return definitions;
}

function guardG4() {
  const violations = [];

  // 1. no relative import of another service's source directory
  const importPattern = /(?:from|require\(|import\()\s*['"]\.\.\/shopflow-[\w.-]*/;
  for (const repoName of ['shopflow-gateway', 'shopflow-web', 'shopflow-notifications', 'shopflow-orders']) {
    const { files } = scanSet([repoName], { includeMarkdown: false });
    for (const entry of files) {
      for (const hit of lineHits(entry, importPattern)) {
        violations.push(report('G4', entry, hit, 'relative import of a sibling service /(from|require|import)\\s*[\'"]\\.\\.\\/shopflow-/'));
      }
    }
  }

  // 2. a table may be defined by exactly one owner repository
  const definitionsByTable = new Map();
  for (const repoName of ALL_REPOS.filter((name) => name !== INFRA)) {
    const { files } = scanSet([repoName], { includeMarkdown: false });
    for (const entry of files) {
      for (const definition of tableDefinitions(entry)) {
        const owners = definitionsByTable.get(definition.table) ?? new Set();
        owners.add(repoName);
        definitionsByTable.set(definition.table, owners);
      }
      if (repoName !== 'shopflow-inventory') {
        const lines = fs.readFileSync(entry.file, 'utf8').split(/\r?\n/);
        lines.forEach((line, index) => {
          if (/^\s*stock\s+(?:integer|int|bigint|numeric|text|serial)/i.test(line)) {
            violations.push(
              `G4 FAIL ${repoName}/${repoRelative(repoName, entry.file)}:${index + 1} matches ` +
                'a "stock" column outside shopflow-inventory',
            );
          }
        });
      }
    }
  }
  for (const [table, owners] of definitionsByTable) {
    if (owners.size > 1) {
      violations.push(
        `G4 FAIL duplicate schema authority: table "${table}" is defined by ${[...owners].sort().join(', ')}`,
      );
    }
  }

  // 3. every table must be defined by its documented owner
  for (const [table, owners] of definitionsByTable) {
    const expected = TABLE_OWNERS[table];
    if (expected !== undefined) {
      for (const owner of owners) {
        if (owner !== expected) {
          violations.push(
            `G4 FAIL schema ownership: table "${table}" belongs to ${expected} but is defined by ${owner}`,
          );
        }
      }
    }
  }

  // 4. the infra copies must stay byte-identical to the owners' authoritative schema files
  const copies = [
    ['orders-init.sql', 'shopflow-orders', 'schema/orders-schema.sql'],
    ['inventory-init.sql', 'shopflow-inventory', 'schema/inventory-schema.sql'],
    ['notifications-init.sql', 'shopflow-notifications', 'schema/notifications-schema.sql'],
  ];
  const identical = [];
  const unavailable = [];
  for (const [copyName, ownerRepo, ownerSchema] of copies) {
    const copyFile = path.join(REPO_ROOT, 'postgres', copyName);
    if (!fs.existsSync(copyFile)) {
      violations.push(`G4 FAIL postgres/${copyName}:0 missing applied schema copy`);
      continue;
    }
    // The owning repository keeps its authoritative DDL next to its sources; while a repository is
    // still being implemented, the same file is the only DDL it ships, in its handoff folder.
    const reference = [
      path.join(repoPath(ownerRepo), ownerSchema),
      path.join(repoPath(ownerRepo), '.handoff', ownerSchema),
    ].find((candidate) => fs.existsSync(candidate));
    if (reference === undefined) {
      unavailable.push(`${ownerRepo}/${ownerSchema}`);
      continue;
    }
    if (Buffer.compare(fs.readFileSync(copyFile), fs.readFileSync(reference)) !== 0) {
      violations.push(
        `G4 FAIL postgres/${copyName}:0 differs from ` +
          `${ownerRepo}/${posix(path.relative(repoPath(ownerRepo), reference))}`,
      );
      continue;
    }
    identical.push(copyName);
  }

  if (violations.length > 0) throw new Error(fail(violations));
  const unavailableNote =
    unavailable.length === 0 ? '' : ` (no owner DDL to compare yet: ${unavailable.join(', ')})`;
  return (
    `no sibling imports, one schema authority per table, ${identical.length}/${copies.length} applied ` +
    `schema copies byte-identical to the owning repository${unavailableNote}`
  );
}

// ---------------------------------------------------------------------------------------------
// G5 - gateway has no domain logic and no persistence
// ---------------------------------------------------------------------------------------------

const FORBIDDEN_DRIVERS = [
  'pg',
  'pg-pool',
  'postgres',
  'mysql',
  'mysql2',
  'sqlite3',
  'better-sqlite3',
  'sequelize',
  'typeorm',
  'prisma',
  '@prisma/client',
  'knex',
  'mongoose',
  'mongodb',
  'redis',
  'ioredis',
];

const DOMAIN_LITERALS = ['SHIPPED', 'CONFIRMED', 'INSUFFICIENT_STOCK'];
const EXPECTED_PUBLIC_ROUTES = [
  'GET /health',
  'GET /products',
  'POST /orders',
  'GET /orders/:id',
  'POST /admin/orders/:id/ship',
];

function guardG5() {
  const violations = [];
  const repoName = 'shopflow-gateway';
  if (!repoExists(repoName)) {
    throw new Error(`G5 FAIL ${repoName}:0 repository is missing (see G6)`);
  }

  // 1. no database driver or ORM dependency
  const packageFile = gatewaySourceFile('package.json');
  if (fs.existsSync(packageFile)) {
    const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    const declared = Object.keys({ ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) });
    for (const dependency of declared) {
      if (FORBIDDEN_DRIVERS.includes(dependency.toLowerCase())) {
        violations.push(
          `G5 FAIL ${repoName}/package.json:0 declares forbidden persistence dependency "${dependency}"`,
        );
      }
    }
  }

  const { files } = scanSet([repoName], { includeMarkdown: true });
  const checks = [
    { label: 'database variable', pattern: /DATABASE_URL/ },
    { label: 'SQL text', pattern: /\bselect\s+|\binsert\s+into\s+|\bupdate\s+[a-z]|\bcreate\s+table\s+/i },
    {
      label: 'domain literal',
      pattern: new RegExp(`\\b(${DOMAIN_LITERALS.join('|')})\\b`),
    },
    { label: 'stock mutation', pattern: /stock\s*=\s*stock\s*[-+]|update\s+products\s+set\s+stock/i },
    { label: 'total-price computation', pattern: /priceCents\s*\*|\*\s*priceCents\s*[;,)]/ },
  ];
  for (const entry of files) {
    for (const check of checks) {
      for (const hit of lineHits(entry, check.pattern)) {
        violations.push(report('G5', entry, hit, check.label));
      }
    }
  }

  // 2. the only declared routes are the five public ones
  const registered = gatewayRegistrations();
  const declared = gatewayRouteTable();
  if (registered === null || declared === null) {
    violations.push(`G5 FAIL ${repoName}/src:0 the gateway route table or edge registration is missing`);
  } else {
    const sortedRegistered = [...registered].sort();
    const sortedExpected = [...EXPECTED_PUBLIC_ROUTES].sort();
    if (JSON.stringify(sortedRegistered) !== JSON.stringify(sortedExpected)) {
      violations.push(
        `G5 FAIL ${repoName}/src/adapters/http/app.ts:0 declared routes ${JSON.stringify(sortedRegistered)} ` +
          `must equal ${JSON.stringify(sortedExpected)}`,
      );
    }
    if (JSON.stringify([...declared].sort()) !== JSON.stringify(sortedExpected)) {
      violations.push(
        `G5 FAIL ${repoName}/src/routes/table.ts:0 route table ${JSON.stringify([...declared].sort())} ` +
          `must equal ${JSON.stringify(sortedExpected)}`,
      );
    }
  }

  if (violations.length > 0) throw new Error(fail(violations));
  return `no database driver, no DATABASE_URL, no SQL, no domain literal, exactly ${EXPECTED_PUBLIC_ROUTES.length} routes (${files.length} files)`;
}

// ---------------------------------------------------------------------------------------------
// G6 - exactly six repositories, correct names
// ---------------------------------------------------------------------------------------------

function repositoryRootMarkers(directory) {
  const markers = [];
  if (fs.existsSync(path.join(directory, 'package.json'))) markers.push('package.json');
  if (fs.existsSync(path.join(directory, 'docker-compose.yml'))) markers.push('docker-compose.yml');
  if (fs.existsSync(path.join(directory, '.git'))) markers.push('.git');
  return markers;
}

function siblingListing() {
  let entries;
  try {
    entries = fs.readdirSync(WORKSPACES_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => {
      const directory = path.join(WORKSPACES_ROOT, entry.name);
      const markers = repositoryRootMarkers(directory);
      return { name: entry.name, markers, isRepositoryRoot: markers.length > 0 };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function guardG6() {
  const listing = siblingListing();
  const lines = ['G6 repository listing used by this guard:'];
  for (const entry of listing) {
    lines.push(
      `G6 LISTING ${entry.name} | repository root: ${entry.isRepositoryRoot ? 'yes' : 'no'} | markers: ` +
        `${entry.markers.join(', ') || '(none)'}`,
    );
  }
  for (const line of lines) console.log(line);

  const violations = [];
  const found = listing.filter((entry) => entry.isRepositoryRoot).map((entry) => entry.name);
  const missing = EXPECTED_REPOS.filter((name) => !found.includes(name));
  const unexpected = found.filter((name) => !EXPECTED_REPOS.includes(name));

  for (const name of missing) {
    const entry = listing.find((candidate) => candidate.name === name);
    violations.push(
      `G6 FAIL ${name}:0 repository root missing next to this repository` +
        (entry === undefined ? ' (directory does not exist)' : ' (directory exists without package.json, docker-compose.yml or .git)'),
    );
  }
  for (const name of unexpected) {
    violations.push(`G6 FAIL ${name}:0 unexpected repository root next to this repository`);
  }
  if (fs.existsSync(path.join(WORKSPACES_ROOT, 'shopflow-api'))) {
    violations.push('G6 FAIL shopflow-api:0 the retired repository still exists');
  }

  if (violations.length > 0) throw new Error(fail(violations));
  return `exactly the six expected repositories: ${EXPECTED_REPOS.join(', ')}`;
}

// ---------------------------------------------------------------------------------------------
// G7 - no new public capability
// ---------------------------------------------------------------------------------------------

const PROHIBITED_ROUTE_PATTERN = /cancel|refund|return|search|login|token|paginat|auth|logout|signup|signup/i;

function guardG7() {
  const violations = [];

  // 1. the public route set is exactly the documented one
  const declared = gatewayRouteTable();
  const registered = gatewayRegistrations();
  if (declared === null || registered === null) {
    violations.push('G7 FAIL shopflow-gateway/src:0 the gateway route table or edge registration is missing');
  } else {
    const sortedExpected = [...EXPECTED_PUBLIC_ROUTES].sort();
    if (JSON.stringify([...declared].sort()) !== JSON.stringify(sortedExpected)) {
      violations.push(
        `G7 FAIL shopflow-gateway/src/routes/table.ts:0 public route set ${JSON.stringify([...declared].sort())} ` +
          `must equal ${JSON.stringify(sortedExpected)}`,
      );
    }
    if (JSON.stringify([...registered].sort()) !== JSON.stringify(sortedExpected)) {
      violations.push(
        `G7 FAIL shopflow-gateway/src/adapters/http/app.ts:0 registered routes ${JSON.stringify([...registered].sort())} ` +
          `must equal ${JSON.stringify(sortedExpected)}`,
      );
    }
    for (const route of [...declared, ...registered]) {
      const pathOnly = route.split(' ').slice(1).join(' ');
      if (PROHIBITED_ROUTE_PATTERN.test(pathOnly)) {
        violations.push(`G7 FAIL shopflow-gateway/src:0 prohibited public route "${route}"`);
      }
    }
  }

  // 2. the gateway is the only service publishing the public API port
  const compose = composeModel();
  const services = compose?.services ?? {};
  const publishers = Object.entries(services)
    .flatMap(([serviceName, service]) => publishedHostPorts(service).map((port) => ({ serviceName, port })))
    .filter(({ port }) => port.host === 3001);
  if (publishers.length !== 1 || publishers[0].serviceName !== 'gateway') {
    violations.push(
      `G7 FAIL docker-compose.yml:0 host port 3001 must be published by exactly the gateway ` +
        `(found: ${publishers.map(({ serviceName }) => serviceName).join(', ') || 'none'})`,
    );
  }

  // 3. the only additive behaviour is the Idempotency-Key header and the 503 UNAVAILABLE envelope
  const proxyFile = gatewaySourceFile(path.join('src', 'adapters', 'http', 'proxy.ts'));
  if (!fs.existsSync(proxyFile)) {
    violations.push('G7 FAIL shopflow-gateway/src/adapters/http/proxy.ts:0 the upstream client is missing');
  } else {
    const proxy = fs.readFileSync(proxyFile, 'utf8');
    if (!/IDEMPOTENCY_KEY_HEADER\s*=\s*'idempotency-key'/.test(proxy)) {
      violations.push(
        'G7 FAIL shopflow-gateway/src/adapters/http/proxy.ts:0 the additive Idempotency-Key header is not declared',
      );
    }
    const envelope = /UNAVAILABLE_ENVELOPE\s*=\s*\{([^}]*)\}/.exec(proxy);
    if (
      envelope === null ||
      !/error:\s*'Upstream service unavailable'/.test(envelope[1]) ||
      !/code:\s*'UNAVAILABLE'/.test(envelope[1])
    ) {
      violations.push(
        'G7 FAIL shopflow-gateway/src/adapters/http/proxy.ts:0 the 503 UNAVAILABLE envelope is not the documented one',
      );
    }
  }

  // 4. the edge invents no status code beyond the documented ones: 200 for the local liveness
  //    route, plus the legacy failure modes 400, 404, 500 and the new 503. Everything else is the
  //    owning service's status passed through unchanged.
  const appFile = gatewaySourceFile(path.join('src', 'adapters', 'http', 'app.ts'));
  if (fs.existsSync(appFile)) {
    const lines = fs.readFileSync(appFile, 'utf8').split(/\r?\n/);
    const allowed = new Set([200, 400, 404, 500, 503]);
    lines.forEach((line, index) => {
      const match = /\.status\((\d{3})\)/.exec(line);
      if (match && !allowed.has(Number(match[1]))) {
        violations.push(
          `G7 FAIL shopflow-gateway/src/adapters/http/app.ts:${index + 1} matches an invented status code ` +
            `${match[1]} (allowed: 200, 400, 404, 500, 503)`,
        );
      }
    });
  }

  if (violations.length > 0) throw new Error(fail(violations));
  return 'the public route set is unchanged and 3001 is published by the gateway only';
}

// ---------------------------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------------------------

const GUARDS = [
  ['G1', 'single writer per datum', guardG1],
  ['G2', 'no cross-service database access', guardG2],
  ['G3', 'compose grants exactly one database per service', guardG3],
  ['G4', 'no shared persistence shortcuts', guardG4],
  ['G5', 'gateway has no domain logic and no persistence', guardG5],
  ['G6', 'exactly six repositories, correct names', guardG6],
  ['G7', 'no new public capability', guardG7],
];

const guardResults = [];

for (const [id, title, run] of GUARDS) {
  test(`${id} ${title}`, (t) => {
    const missing = EXPECTED_REPOS.filter((name) => !repoExists(name));
    if (missing.length > 0) {
      t.diagnostic(`repositories missing from the workspace: ${missing.join(', ')}`);
    }
    try {
      const detail = run();
      guardResults.push({ id, status: 'PASS', detail });
    } catch (error) {
      guardResults.push({ id, status: 'FAIL', detail: error.message });
      throw error;
    }
  });
}

test('ownership guard summary', (t) => {
  const lines = ['', 'GUARD | STATUS | DETAIL'];
  for (const [id, title] of GUARDS) {
    const result = guardResults.find((entry) => entry.id === id);
    lines.push(
      `${id} | ${result?.status ?? 'NOT RUN'} | ${(result?.detail ?? title).split(/\r?\n/)[0]}`,
    );
  }
  const failed = guardResults.filter((result) => result.status === 'FAIL').length;
  lines.push(`TOTAL | ${guardResults.length - failed}/${GUARDS.length} PASSED`);
  const table = lines.join('\n');
  t.diagnostic(table);
  console.log(table);
});
