/**
 * Upstream client for the gateway edge.
 *
 * Responsibilities (and nothing else):
 *  - build the upstream URL from the declarative route table;
 *  - propagate `x-correlation-id` and forward `Idempotency-Key` when the client sent one;
 *  - apply a bounded per-attempt timeout (`UPSTREAM_TIMEOUT_MS`);
 *  - retry exactly once, and only for safe reads, and only on a *connection* failure;
 *  - hand the upstream status, content type and raw response bytes back untouched.
 *
 * There is no request/response transformation, no aggregation, no caching and no persistence here.
 */
import type { Logger } from '../../observability/logger.js';
import type { UpstreamName } from '../../routes/table.js';

export const CORRELATION_ID_HEADER = 'x-correlation-id';
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const CONTENT_TYPE_HEADER = 'content-type';

/** The only gateway-invented error envelope: the owning service could not be reached at all. */
export const UNAVAILABLE_ENVELOPE = {
  error: 'Upstream service unavailable',
  code: 'UNAVAILABLE',
} as const;

export const UNAVAILABLE_BODY = JSON.stringify(UNAVAILABLE_ENVELOPE);

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface UpstreamTarget {
  readonly name: UpstreamName;
  readonly baseUrl: string;
}

export interface UpstreamRequestSpec {
  readonly target: UpstreamTarget;
  readonly method: 'GET' | 'POST';
  /** Already resolved upstream path, e.g. `/orders/<id>/ship`. */
  readonly path: string;
  readonly correlationId: string;
  readonly contentType?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly body?: Buffer | undefined;
  readonly timeoutMs: number;
  readonly retryOnConnectionFailure: boolean;
}

export interface UpstreamResponse {
  readonly status: number;
  readonly contentType?: string | undefined;
  readonly body: Buffer;
}

export type ForwardOutcome =
  | { readonly kind: 'response'; readonly response: UpstreamResponse }
  | { readonly kind: 'transport-failure'; readonly error: unknown; readonly attempts: number };

export interface ForwardOptions {
  readonly logger: Logger;
  readonly fetchImpl?: FetchLike | undefined;
}

/** Aborts of any flavour mean the timeout fired; those are not retried. */
function isTimeoutFailure(error: unknown): boolean {
  const names = [error, (error as { cause?: unknown } | null | undefined)?.cause].map((candidate) =>
    (candidate as { name?: unknown } | null | undefined)?.name,
  );
  return names.some((name) => name === 'TimeoutError' || name === 'AbortError');
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function upstreamUrl(target: UpstreamTarget, path: string): string {
  return `${target.baseUrl.replace(/\/+$/, '')}${path}`;
}

export async function forwardToUpstream(
  request: UpstreamRequestSpec,
  options: ForwardOptions,
): Promise<ForwardOutcome> {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const url = upstreamUrl(request.target, request.path);

  const headers: Record<string, string> = {
    [CORRELATION_ID_HEADER]: request.correlationId,
  };
  if (request.contentType !== undefined) {
    headers[CONTENT_TYPE_HEADER] = request.contentType;
  }
  if (request.idempotencyKey !== undefined) {
    headers[IDEMPOTENCY_KEY_HEADER] = request.idempotencyKey;
  }

  const maxAttempts = request.retryOnConnectionFailure ? 2 : 1;
  let attempts = 0;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    try {
      const response = await fetchImpl(url, {
        method: request.method,
        headers,
        body: request.body === undefined ? undefined : new Uint8Array(request.body),
        signal: AbortSignal.timeout(request.timeoutMs),
      });
      const body = Buffer.from(await response.arrayBuffer());
      return {
        kind: 'response',
        response: {
          status: response.status,
          contentType: response.headers.get(CONTENT_TYPE_HEADER) ?? undefined,
          body,
        },
      };
    } catch (error) {
      lastError = error;
      // Only a connection failure on a safe read is retried, and only once.
      if (attempt < maxAttempts && !isTimeoutFailure(error)) {
        continue;
      }
      break;
    }
  }

  options.logger.error({
    event: 'upstream_transport_failure',
    upstream: request.target.name,
    upstreamUrl: url,
    method: request.method,
    correlationId: request.correlationId,
    attempts,
    reason: describeError(lastError),
  });

  return { kind: 'transport-failure', error: lastError, attempts };
}
