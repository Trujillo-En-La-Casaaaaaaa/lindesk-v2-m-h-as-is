/**
 * Gateway configuration.
 *
 * Four variables only - no database URL, no credentials, no secrets (see
 * `design/gateway-routing-table.md`, section "Configuration").
 */
export interface GatewayConfig {
  readonly port: number;
  readonly ordersUrl: string;
  readonly inventoryUrl: string;
  readonly upstreamTimeoutMs: number;
}

export const DEFAULT_PORT = 3001;
export const DEFAULT_ORDERS_URL = 'http://orders:3002';
export const DEFAULT_INVENTORY_URL = 'http://inventory:3003';
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 5000;

function readPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_PORT;
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, received "${raw}"`);
  }
  return value;
}

function readBaseUrl(raw: string | undefined, fallback: string, variable: string): string {
  const candidate = (raw ?? '').trim();
  if (candidate === '') {
    return fallback;
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${variable} must be an absolute http(s) URL, received "${raw}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${variable} must use http or https, received "${raw}"`);
  }
  return candidate.replace(/\/+$/, '');
}

function readPositiveInteger(raw: string | undefined, fallback: number, variable: string): number {
  const candidate = (raw ?? '').trim();
  if (candidate === '') {
    return fallback;
  }
  const value = Number(candidate);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${variable} must be a positive integer, received "${raw}"`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  return {
    port: readPort(env.PORT),
    ordersUrl: readBaseUrl(env.ORDERS_URL, DEFAULT_ORDERS_URL, 'ORDERS_URL'),
    inventoryUrl: readBaseUrl(env.INVENTORY_URL, DEFAULT_INVENTORY_URL, 'INVENTORY_URL'),
    upstreamTimeoutMs: readPositiveInteger(
      env.UPSTREAM_TIMEOUT_MS,
      DEFAULT_UPSTREAM_TIMEOUT_MS,
      'UPSTREAM_TIMEOUT_MS',
    ),
  };
}
