import {
  ProviderError,
  type NotificationProvider,
  type ProviderAcceptance,
  type ProviderNotificationRecord,
  type ProviderOrderConfirmationPayload,
} from '../../ports/notification-provider.js';

export interface HttpNotificationProviderOptions {
  /** Base URL of the unchanged provider emulator, e.g. `http://localhost:4010`. */
  readonly baseUrl: string;
  /** Legacy delivery timeout (3 s by default). */
  readonly timeoutMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return name === 'TimeoutError' || name === 'AbortError';
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error) {
      const code = (cause as { code?: unknown }).code;
      if (typeof code === 'string') {
        return `${error.message} (${code})`;
      }
    }
    if (cause instanceof Error) {
      return `${error.message} (${cause.message})`;
    }
    return error.message;
  }
  return String(error);
}

/**
 * Adapter for the external provider contract. The contract is unchanged by the
 * migration: `POST /notifications` (payload exactly the three legacy fields and a
 * 3 second timeout via `AbortSignal.timeout`), `GET /notifications` for the
 * reconcile check. `GET /health` is never called during request handling.
 */
export class HttpNotificationProvider implements NotificationProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: HttpNotificationProviderOptions) {
    const baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
    if (baseUrl === '') {
      throw new Error('PROVIDER_URL must not be empty');
    }
    this.baseUrl = baseUrl;
    this.timeoutMs = options.timeoutMs;
  }

  async sendOrderConfirmation(payload: ProviderOrderConfirmationPayload): Promise<ProviderAcceptance> {
    const body = await this.request('POST', '/notifications', payload);
    const id = isRecord(body) ? body.id : undefined;
    if (typeof id !== 'string' || id === '') {
      throw new ProviderError('PROVIDER_ERROR', 'provider response did not contain a provider record id');
    }
    return { id };
  }

  async listNotifications(): Promise<ProviderNotificationRecord[]> {
    const body = await this.request('GET', '/notifications');
    if (!Array.isArray(body)) {
      throw new ProviderError('PROVIDER_ERROR', 'provider inspection endpoint did not return an array');
    }
    return body as ProviderNotificationRecord[];
  }

  private async request(method: 'GET' | 'POST', path: string, payload?: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw this.toProviderError(method, path, error);
    }

    const text = await this.readBody(response, method, path);

    if (!response.ok) {
      const detail = text.trim().slice(0, 200);
      throw new ProviderError('PROVIDER_ERROR', `provider ${method} ${path} responded ${response.status}${detail === '' ? '' : `: ${detail}`}`);
    }

    if (text.trim() === '') {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new ProviderError('PROVIDER_ERROR', `provider ${method} ${path} returned invalid JSON`);
    }
  }

  private async readBody(response: Response, method: string, path: string): Promise<string> {
    try {
      return await response.text();
    } catch (error) {
      throw this.toProviderError(method, path, error);
    }
  }

  private toProviderError(method: string, path: string, error: unknown): ProviderError {
    if (error instanceof ProviderError) {
      return error;
    }
    if (isTimeoutError(error)) {
      return new ProviderError('PROVIDER_TIMEOUT', `provider ${method} ${path} timed out after ${this.timeoutMs} ms`);
    }
    return new ProviderError('PROVIDER_ERROR', `provider ${method} ${path} failed: ${describeError(error)}`);
  }
}
