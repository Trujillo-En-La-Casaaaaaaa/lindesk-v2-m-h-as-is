/** Minimal structured logging: one JSON object per line on stdout/stderr, no dependency. */

import { errorDetail } from './domain/errors.js';

export type LogLevel = 'info' | 'warn' | 'error';

export function logJson(level: LogLevel, message: string, detail?: string): void {
  const line = JSON.stringify(detail === undefined ? { level, message } : { level, message, detail });
  if (level === 'error') {
    process.stderr.write(`${line}\n`);
    return;
  }
  process.stdout.write(`${line}\n`);
}

export { errorDetail };

export type ErrorLogger = (message: string, error: unknown) => void;

export const defaultErrorLogger: ErrorLogger = (message, error) => {
  logJson('error', message, errorDetail(error));
};
