/**
 * Configuration of the inventory service.
 *
 * Exactly two variables exist in this repository: `PORT` (default 3003) and
 * `INVENTORY_DATABASE_URL`, the connection string of the one database this service owns. No other
 * database variable, and no URL of any other service, may be introduced here.
 */

export const DEFAULT_PORT = 3003;

export interface InventoryConfig {
  readonly port: number;
  readonly databaseUrl: string;
}

export function loadConfig(environment: NodeJS.ProcessEnv): InventoryConfig {
  return {
    port: parsePort(environment.PORT),
    databaseUrl: requiredDatabaseUrl(environment.INVENTORY_DATABASE_URL),
  };
}

function parsePort(rawPort: string | undefined): number {
  if (rawPort === undefined || rawPort.trim() === '') {
    return DEFAULT_PORT;
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be a TCP port number between 1 and 65535 (received "${rawPort}")`);
  }
  return port;
}

function requiredDatabaseUrl(rawUrl: string | undefined): string {
  if (rawUrl === undefined || rawUrl.trim() === '') {
    throw new Error('INVENTORY_DATABASE_URL is required: the service owns exactly one database');
  }
  return rawUrl.trim();
}
