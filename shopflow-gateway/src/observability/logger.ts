/**
 * Structured logging for the gateway edge.
 *
 * The gateway emits one JSON object per line. Only transport-level facts are logged
 * (which upstream failed, which correlation id, which route); no request or response
 * payloads are logged, because the gateway owns no domain data.
 */
export interface LogFields {
  readonly [key: string]: unknown;
}

export interface Logger {
  info(fields: LogFields): void;
  error(fields: LogFields): void;
}

export interface CapturedLog {
  readonly level: 'info' | 'error';
  readonly fields: LogFields;
}

export interface CapturingLogger extends Logger {
  readonly entries: CapturedLog[];
}

function write(level: 'info' | 'error', fields: LogFields): void {
  const line = `${JSON.stringify({ level, ...fields })}\n`;
  if (level === 'error') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

export const activeLogger: Logger = {
  info: (fields) => write('info', fields),
  error: (fields) => write('error', fields),
};

export const silentLogger: Logger = {
  info: () => undefined,
  error: () => undefined,
};

/** Test/verification helper: keeps emitted log lines in memory. */
export function createCapturingLogger(): CapturingLogger {
  const entries: CapturedLog[] = [];
  return {
    entries,
    info: (fields) => entries.push({ level: 'info', fields }),
    error: (fields) => entries.push({ level: 'error', fields }),
  };
}
