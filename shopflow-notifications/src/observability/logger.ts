export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface JsonLoggerOptions {
  readonly service?: string;
  readonly write?: (line: string) => void;
}

/** Minimal structured (JSON line) logger - no secrets, no dependencies. */
export function createLogger(options: JsonLoggerOptions = {}): Logger {
  const service = options.service ?? 'shopflow-notifications';
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));

  const emit = (level: 'info' | 'warn' | 'error', message: string, context?: Record<string, unknown>): void => {
    const entry = { level, time: new Date().toISOString(), service, message, ...(context ?? {}) };
    try {
      write(JSON.stringify(entry));
    } catch {
      write(`${level} ${message}`);
    }
  };

  return {
    info: (message, context) => emit('info', message, context),
    warn: (message, context) => emit('warn', message, context),
    error: (message, context) => emit('error', message, context),
  };
}

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
