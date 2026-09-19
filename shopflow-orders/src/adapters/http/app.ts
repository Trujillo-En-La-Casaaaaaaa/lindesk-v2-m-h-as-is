/**
 * The HTTP adapter: the five endpoints of `apis/orders-service-api.md` version 1.
 *
 * ```text
 *   GET  /health                     200 {"ok":true}                      (no database round trip)
 *   POST /orders                     201 | 200 (replay) | 400 | 404 | 500 | 503
 *   GET  /orders/:id                 200 | 404
 *   POST /orders/:id/ship            200 | 404 | 409
 *   GET  /orders/:id/operations      200 | 404                            (internal diagnostic)
 * ```
 *
 * The adapter maps outcomes to statuses and nothing else: every rule lives in the domain and in the
 * application services. Errors use the two-field legacy envelope, except the documented `500` body,
 * which carries `error` only.
 */

import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import {
  InsufficientStockError,
  InvalidOrderRequestError,
  LEGACY_MESSAGES,
  OrderNotFoundError,
  OrderNotShippableError,
  ProductNotFoundError,
  UpstreamUnavailableError,
  type ErrorEnvelope,
} from '../../domain/errors.js';
import { parseClientIdempotencyKey } from '../../domain/order-request.js';
import { defaultErrorLogger, type ErrorLogger } from '../../logging.js';
import type { OrderService } from '../../application/order-service.js';
import type { CreateOrderOutcome, OrderCreationService } from '../../application/saga/order-creation-service.js';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const CORRELATION_ID_HEADER = 'x-correlation-id';
export const IDEMPOTENT_REPLAY_HEADER = 'x-idempotent-replay';

const INTERNAL_ERROR_ENVELOPE: ErrorEnvelope = { error: LEGACY_MESSAGES.internal };
const ROUTE_NOT_FOUND_ENVELOPE: ErrorEnvelope = { error: 'Not found', code: 'NOT_FOUND' };

export interface OrdersHttpDependencies {
  readonly creation: OrderCreationService;
  readonly orders: OrderService;
  readonly logError?: ErrorLogger | undefined;
}

export function createOrdersApp(dependencies: OrdersHttpDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(correlationId);
  app.use(express.json({ limit: '64kb' }));

  // Liveness: answered without a database round trip, so it can gate the Compose healthcheck.
  app.get('/health', (_request: Request, response: Response) => {
    response.status(200).json({ ok: true });
  });

  app.post('/orders', async (request: Request, response: Response) => {
    const outcome = await dependencies.creation.createOrder({
      body: request.body,
      clientIdempotencyKey: parseClientIdempotencyKey(request.get(IDEMPOTENCY_KEY_HEADER)),
      correlationId: correlationIdOf(response),
    });
    sendCreateOrderOutcome(response, outcome);
  });

  app.get('/orders/:id', async (request: Request, response: Response) => {
    response.status(200).json(await dependencies.orders.getOrder(pathParameter(request, 'id') ?? ''));
  });

  app.post('/orders/:id/ship', async (request: Request, response: Response) => {
    response.status(200).json(await dependencies.orders.shipOrder(pathParameter(request, 'id') ?? ''));
  });

  app.get('/orders/:id/operations', async (request: Request, response: Response) => {
    response.status(200).json(await dependencies.orders.getOrderOperation(pathParameter(request, 'id') ?? ''));
  });

  app.use((_request: Request, response: Response) => {
    response.status(404).json(ROUTE_NOT_FOUND_ENVELOPE);
  });

  app.use(errorHandler(dependencies));
  return app;
}

function sendCreateOrderOutcome(response: Response, outcome: CreateOrderOutcome): void {
  switch (outcome.kind) {
    case 'created':
      response.status(201).json(outcome.order);
      return;
    case 'replayed':
      // A known client Idempotency-Key: the order of the first request, marked as a replay.
      response.setHeader(IDEMPOTENT_REPLAY_HEADER, 'true');
      response.status(200).json(outcome.order);
      return;
    case 'confirmation-failed':
      // The order is committed and stays CONFIRMED; the durable outbox retries the confirmation.
      response.status(500).json(INTERNAL_ERROR_ENVELOPE);
      return;
    case 'insufficient-stock':
      sendEnvelope(response, new InsufficientStockError());
      return;
    case 'product-not-found':
      sendEnvelope(response, new ProductNotFoundError());
      return;
    case 'unavailable':
      sendEnvelope(response, new UpstreamUnavailableError());
      return;
    case 'internal':
      response.status(500).json(INTERNAL_ERROR_ENVELOPE);
      return;
  }
}

function sendEnvelope(response: Response, error: { status: number; envelope(): ErrorEnvelope }): void {
  response.status(error.status).json(error.envelope());
}

function correlationId(request: Request, response: Response, next: NextFunction): void {
  const supplied = request.get(CORRELATION_ID_HEADER);
  const correlation = supplied !== undefined && supplied.trim() !== '' ? supplied : randomUUID();
  response.setHeader(CORRELATION_ID_HEADER, correlation);
  next();
}

function correlationIdOf(response: Response): string | undefined {
  const value = response.getHeader(CORRELATION_ID_HEADER);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Express types a route parameter as `string | string[] | undefined`; these routes only get strings. */
function pathParameter(request: Request, name: string): string | undefined {
  const value: unknown = request.params[name];
  return typeof value === 'string' ? value : undefined;
}

function errorHandler(dependencies: OrdersHttpDependencies) {
  return (error: unknown, _request: Request, response: Response, next: NextFunction): void => {
    if (response.headersSent) {
      next(error);
      return;
    }
    if (
      error instanceof InvalidOrderRequestError ||
      error instanceof InsufficientStockError ||
      error instanceof ProductNotFoundError ||
      error instanceof OrderNotFoundError ||
      error instanceof OrderNotShippableError ||
      error instanceof UpstreamUnavailableError
    ) {
      sendEnvelope(response, error);
      return;
    }
    if (isJsonBodyParseError(error)) {
      // A malformed payload is the same rejection the legacy service answered to its clients.
      sendEnvelope(response, new InvalidOrderRequestError());
      return;
    }
    const logError = dependencies.logError ?? defaultErrorLogger;
    logError('unhandled failure while serving an orders request', error);
    response.status(500).json(INTERNAL_ERROR_ENVELOPE);
  };
}

/** `express.json()` rejects malformed payloads with a tagged `SyntaxError`. */
function isJsonBodyParseError(error: unknown): boolean {
  return error instanceof SyntaxError && (error as { type?: unknown }).type === 'entity.parse.failed';
}
