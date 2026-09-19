/** Minimal structured logging: one JSON object per line on stdout/stderr. */

export type LogLevel = 'info' | 'error';

export function logJson(level: LogLevel, message: string, detail?: string): void {
  const entry = detail === undefined ? { level, message } : { level, message, detail };
  const line = `${JSON.stringify(entry)}\n`;
  if (level === 'error') {
    process.stderr.write(line);
    return;
  }
  process.stdout.write(line);
}

export function errorDetail(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
