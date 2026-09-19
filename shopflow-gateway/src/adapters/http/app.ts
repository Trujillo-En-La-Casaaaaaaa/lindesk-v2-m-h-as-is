/**
 * The public HTTP edge.
 *
 * Composition: cors -> json body parsing -> correlation-id middleware -> route table -> upstream clients.
 * The application contains no business logic and no persistence; every domain response comes from the
 * owning service and is passed through byte-for-byte.
 */
import { randomUUID } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import type { GatewayConfig } from '../../config.js';
import { activeLogger, type Logger } from '../../observability/logger.js';
import { findRoute, resolveUpstreamPath, type GatewayRoute } from '../../routes/table.js';
import {
  CONTENT_TYPE_HEADER,
  CORRELATION_ID_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  UNAVAILABLE_ENVELOPE,
  forwardToUpstream,
  type FetchLike,
  type UpstreamTarget,
} from './proxy.js';

export interface AppDependencies {
  readonly config: GatewayConfig;
  readonly logger?: Logger;
  readonly fetchImpl?: FetchLike;
}

/** Conservative charset for a caller-supplied correlation id (header-injection safe). */
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function readOrCreateCorrelationId(candidate: string | string[] | undefined): string {
  const value = Array.isArray(candidate) ? candidate[0] : candidate;
  if (typeof value === 'string' && CORRELATION_ID_PATTERN.test(value)) {
    return value;
  }
  return randomUUID();
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const single = Array.isArray(value) ? value[0] : value;
  return single === undefined || single === '' ? undefined : single;
}

interface RawBodyCarrier {
  rawBody?: Buffer;
}

/**
 * Bodies are captured verbatim while still being parsed as JSON (parsing is required so that
 * malformed JSON is rejected at the edge instead of being proxied blindly).
 */
function captureRawBody(request: Request, _response: Response, buffer: Buffer): void {
  if (buffer.length > 0) {
    (request as Request & RawBodyCarrier).rawBody = Buffer.from(buffer);
  }
}

function requestBodyFor(request: Request, route: GatewayRoute): Buffer | undefined {
  const rawBody = (request as Request & RawBodyCarrier).rawBody;
  if (rawBody !== undefined && rawBody.length > 0) {
    return rawBody;
  }
  const parsed: unknown = request.body;
  if (
    route.method === 'POST' &&
    parsed !== null &&
    typeof parsed === 'object' &&
    !Buffer.isBuffer(parsed) &&
    Object.keys(parsed as Record<string, unknown>).length > 0
  ) {
    return Buffer.from(JSON.stringify(parsed), 'utf8');
  }
  return undefined;
}

export function createApp(dependencies: AppDependencies): Express {
  const { config } = dependencies;
  const logger = dependencies.logger ?? activeLogger;
  const fetchImpl = dependencies.fetchImpl;

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use(cors());
  app.use(express.json({ verify: captureRawBody }));

  app.use((request: Request, response: Response, next: NextFunction) => {
    const correlationId = readOrCreateCorrelationId(request.headers[CORRELATION_ID_HEADER]);
    response.locals.correlationId = correlationId;
    response.setHeader(CORRELATION_ID_HEADER, correlationId);
    next();
  });

  const proxyHandler = (route: GatewayRoute) => (request: Request, response: Response): void => {
    void proxyRequest(route, request, response, { config, logger, fetchImpl });
  };

  // The five public routes. Everything except liveness is described by the declarative
  // route table (`src/routes/table.ts`); `findRoute` fails fast on any divergence.
  app.get('/health', liveness);
  app.get('/products', proxyHandler(findRoute('GET', '/products')));
  app.post('/orders', proxyHandler(findRoute('POST', '/orders')));
  app.get('/orders/:id', proxyHandler(findRoute('GET', '/orders/:id')));
  app.post('/admin/orders/:id/ship', proxyHandler(findRoute('POST', '/admin/orders/:id/ship')));

  app.use(notFound);
  app.use(handleEdgeError(logger));

  return app;
}

async function proxyRequest(
  route: GatewayRoute,
  request: Request,
  response: Response,
  dependencies: { config: GatewayConfig; logger: Logger; fetchImpl?: FetchLike | undefined },
): Promise<void> {
  const { config, logger, fetchImpl } = dependencies;
  const correlationId = String(response.locals.correlationId);
  const target: UpstreamTarget = {
    name: route.owner === 'inventory' ? 'inventory' : 'orders',
    baseUrl: route.owner === 'inventory' ? config.inventoryUrl : config.ordersUrl,
  };

  const outcome = await forwardToUpstream(
    {
      target,
      method: route.upstreamMethod ?? 'GET',
      path: resolveUpstreamPath(route.upstreamPathTemplate ?? '', request.params as Record<string, string>),
      correlationId,
      contentType: headerValue(request.headers[CONTENT_TYPE_HEADER]),
      idempotencyKey: headerValue(request.headers[IDEMPOTENCY_KEY_HEADER]),
      body: requestBodyFor(request, route),
      timeoutMs: config.upstreamTimeoutMs,
      retryOnConnectionFailure: route.retryOnConnectionFailure,
    },
    { logger, fetchImpl },
  );

  if (outcome.kind === 'transport-failure') {
    // Only a transport failure becomes 503; an upstream error body is never masked this way.
    response.status(503).json(UNAVAILABLE_ENVELOPE);
    return;
  }

  response.status(outcome.response.status);
  if (outcome.response.contentType !== undefined) {
    response.setHeader(CONTENT_TYPE_HEADER, outcome.response.contentType);
  }
  response.setHeader('content-length', String(outcome.response.body.length));
  response.end(outcome.response.body);
}

function notFound(_request: Request, response: Response): void {
  response.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
}

// Liveness only: never touches the upstreams (public contract, `GET /health`).
function liveness(_request: Request, response: Response): void {
  response.status(200).json({ ok: true });
}

function handleEdgeError(logger: Logger): (error: unknown, request: Request, response: Response, next: NextFunction) => void {
  return (error, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const status = (error as { status?: unknown } | null | undefined)?.status;
    const type = (error as { type?: unknown } | null | undefined)?.type;
    if (type === 'entity.parse.failed' || status === 400) {
      response.status(400).json({ error: 'Invalid JSON body', code: 'INVALID' });
      return;
    }
    logger.error({
      event: 'edge_error',
      method: request.method,
      path: request.path,
      correlationId: String(response.locals.correlationId ?? ''),
      reason: error instanceof Error ? error.message : String(error),
    });
    response.status(500).json({ error: 'Internal server error' });
  };
}
