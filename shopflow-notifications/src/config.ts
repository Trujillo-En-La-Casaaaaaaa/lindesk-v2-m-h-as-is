/**
 * Runtime configuration. Exactly one database variable name exists in this
 * repository: `NOTIFICATIONS_DATABASE_URL` (the notifications-db owned by this
 * service). Every default is a local, credential-free value.
 */
export interface NotificationServiceConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly providerUrl: string;
  readonly providerTimeoutMs: number;
  readonly deliveryIntervalMs: number;
  readonly deliveryBackoffBaseMs: number;
  /** `0` means unlimited attempts (default). */
  readonly deliveryMaxAttempts: number;
  /** `false` disables the background worker loop (unit tests never sleep). */
  readonly deliveryWorkerEnabled: boolean;
}

export const CONFIG_DEFAULTS = {
  port: 3004,
  databaseUrl: 'postgresql://postgres:postgres@localhost:5432/notifications',
  providerUrl: 'http://localhost:4010',
  providerTimeoutMs: 3000,
  deliveryIntervalMs: 1000,
  deliveryBackoffBaseMs: 250,
  deliveryMaxAttempts: 0,
  deliveryWorkerEnabled: true,
} as const satisfies NotificationServiceConfig;

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function readString(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  return raw.trim();
}

function readInteger(env: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < minimum) {
    throw new ConfigurationError(`${name} must be an integer >= ${minimum}, received "${raw}"`);
  }
  return value;
}

function readBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(value)) {
    return false;
  }
  throw new ConfigurationError(`${name} must be a boolean, received "${raw}"`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): NotificationServiceConfig {
  return {
    port: readInteger(env, 'PORT', CONFIG_DEFAULTS.port, 1),
    databaseUrl: readString(env, 'NOTIFICATIONS_DATABASE_URL', CONFIG_DEFAULTS.databaseUrl),
    providerUrl: readString(env, 'PROVIDER_URL', CONFIG_DEFAULTS.providerUrl),
    providerTimeoutMs: readInteger(env, 'PROVIDER_TIMEOUT_MS', CONFIG_DEFAULTS.providerTimeoutMs, 1),
    deliveryIntervalMs: readInteger(env, 'DELIVERY_INTERVAL_MS', CONFIG_DEFAULTS.deliveryIntervalMs, 1),
    deliveryBackoffBaseMs: readInteger(env, 'DELIVERY_BACKOFF_BASE_MS', CONFIG_DEFAULTS.deliveryBackoffBaseMs, 1),
    deliveryMaxAttempts: readInteger(env, 'DELIVERY_MAX_ATTEMPTS', CONFIG_DEFAULTS.deliveryMaxAttempts, 0),
    deliveryWorkerEnabled: readBoolean(env, 'DELIVERY_WORKER_ENABLED', CONFIG_DEFAULTS.deliveryWorkerEnabled),
  };
}
