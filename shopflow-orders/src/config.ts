/**
 * Runtime configuration of the orders service.
 *
 * Exactly nine variables exist in this repository; `ORDERS_DATABASE_URL` is the only database
 * variable name that may appear here (ownership guard G2 of `shopflow-infra`), and it names the one
 * database this service owns. Every default is a local, credential-free value (see `.env.example`).
 */

export interface OrdersConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly inventoryUrl: string;
  readonly notificationsUrl: string;
  /** Recovery worker period. `0` disables the loop (tests drive the recovery explicitly). */
  readonly sagaIntervalMs: number;
  /** Outbox dispatcher period. `0` disables the loop. */
  readonly outboxIntervalMs: number;
  /** Base of the bounded exponential backoff of the outbox dispatcher. */
  readonly outboxBackoffBaseMs: number;
  /** Inline attempts of the inventory decrement inside one `POST /orders`. */
  readonly inlineCallAttempts: number;
  /** Per-attempt timeout of every outbound call. */
  readonly upstreamTimeoutMs: number;
}

export const CONFIG_DEFAULTS = {
  port: 3002,
  inventoryUrl: 'http://localhost:3003',
  notificationsUrl: 'http://localhost:3004',
  sagaIntervalMs: 1000,
  outboxIntervalMs: 1000,
  outboxBackoffBaseMs: 250,
  inlineCallAttempts: 2,
  upstreamTimeoutMs: 3000,
} as const;

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function readString(environment: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  return raw.trim();
}

function readRequiredString(environment: NodeJS.ProcessEnv, name: string): string {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === '') {
    throw new ConfigurationError(`${name} is required: the service owns exactly one database`);
  }
  return raw.trim();
}

function readInteger(environment: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number): number {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < minimum) {
    throw new ConfigurationError(`${name} must be an integer >= ${minimum} (received "${raw}")`);
  }
  return value;
}

function readBaseUrl(environment: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = readString(environment, name, fallback).replace(/\/+$/, '');
  if (value === '') {
    throw new ConfigurationError(`${name} must be an absolute URL`);
  }
  return value;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): OrdersConfig {
  return {
    port: readInteger(environment, 'PORT', CONFIG_DEFAULTS.port, 1),
    databaseUrl: readRequiredString(environment, 'ORDERS_DATABASE_URL'),
    inventoryUrl: readBaseUrl(environment, 'INVENTORY_URL', CONFIG_DEFAULTS.inventoryUrl),
    notificationsUrl: readBaseUrl(environment, 'NOTIFICATIONS_URL', CONFIG_DEFAULTS.notificationsUrl),
    sagaIntervalMs: readInteger(environment, 'SAGA_INTERVAL_MS', CONFIG_DEFAULTS.sagaIntervalMs, 0),
    outboxIntervalMs: readInteger(environment, 'OUTBOX_INTERVAL_MS', CONFIG_DEFAULTS.outboxIntervalMs, 0),
    outboxBackoffBaseMs: readInteger(
      environment,
      'OUTBOX_BACKOFF_BASE_MS',
      CONFIG_DEFAULTS.outboxBackoffBaseMs,
      1,
    ),
    inlineCallAttempts: readInteger(
      environment,
      'INLINE_CALL_ATTEMPTS',
      CONFIG_DEFAULTS.inlineCallAttempts,
      1,
    ),
    upstreamTimeoutMs: readInteger(environment, 'UPSTREAM_TIMEOUT_MS', CONFIG_DEFAULTS.upstreamTimeoutMs, 1),
  };
}
