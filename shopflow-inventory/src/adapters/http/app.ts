import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';
import { randomUUID } from 'node:crypto';
import type { CatalogService } from '../../application/catalog-service.js';
import { parseStockDecrementRequest } from '../../application/stock-decrement-request.js';
import type { StockService } from '../../application/stock-service.js';
import type { StockDecrementRecord } from '../../domain/stock-decrement.js';
import {
  InsufficientStockError,
  InvalidStockDecrementRequestError,
  InventoryRequestError,
  ProductNotFoundError,
} from '../../domain/errors.js';
import { errorDetail, logJson } from '../../logging.js';

/** `apis/inventory-service-api.md` v1: the caller-supplied idempotency key carries the order id. */
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
const CORRELATION_ID_HEADER = 'x-correlation-id';
const IDEMPOTENT_REPLAY_HEADER = 'x-idempotent-replay';

/** The documented 500 body carries only `error`. */
const INTERNAL_ERROR_ENVELOPE = { error: 'Internal server error' } as const;
const ROUTE_NOT_FOUND_ENVELOPE = { error: 'Not found', code: 'NOT_FOUND' } as const;

export type ErrorLogger = (message: string, error: unknown) => void;

export interface InventoryHttpDependencies {
  readonly catalog: CatalogService;
  readonly stock: StockService;
  readonly logError?: ErrorLogger | undefined;
}

/**
 * The five documented endpoints of `apis/inventory-service-api.md` version 1.
 *
 * `/health` answers without a database round trip so it can gate the Compose healthcheck.
 */
export function createInventoryApp(dependencies: InventoryHttpDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(correlationId);
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_request: Request, response: Response) => {
    response.status(200).json({ ok: true });
  });

  app.get('/products', async (_request: Request, response: Response) => {
    response.status(200).json(await dependencies.catalog.listProducts());
  });

  app.get('/products/:id', async (request: Request, response: Response) => {
    const product = await dependencies.catalog.getProduct(pathParameter(request, 'id') ?? '');
    response.status(200).json(product);
  });

  app.post('/stock-decrements', async (request: Request, response: Response) => {
    const decrementRequest = parseStockDecrementRequest(request.get(IDEMPOTENCY_KEY_HEADER), request.body);
    const { record, replayed } = await dependencies.stock.decrementStock(decrementRequest);

    if (record.outcome === 'INSUFFICIENT_STOCK') {
      sendEnvelope(response, new InsufficientStockError());
      return;
    }
    if (record.outcome === 'NOT_FOUND') {
      sendEnvelope(response, new ProductNotFoundError());
      return;
    }
    if (replayed) {
      // A repeat of a known order id: the recorded outcome with the recorded status code.
      response.setHeader(IDEMPOTENT_REPLAY_HEADER, 'true');
      response.status(200).json(decrementBody(record));
      return;
    }
    response.status(201).json(decrementBody(record));
  });

  app.post('/stock-decrements/:orderId/release', async (request: Request, response: Response) => {
    const outcome = await dependencies.stock.releaseStock(pathParameter(request, 'orderId') ?? '');
    response.status(200).json({
      orderId: outcome.orderId,
      status: 'RELEASED',
      releasedQuantity: outcome.releasedQuantity,
      remainingStock: outcome.remainingStock,
    });
  });

  app.use((_request: Request, response: Response) => {
    response.status(404).json(ROUTE_NOT_FOUND_ENVELOPE);
  });

  app.use(errorHandler(dependencies));
  return app;
}

function correlationId(request: Request, response: Response, next: NextFunction): void {
  const supplied = request.get(CORRELATION_ID_HEADER);
  const correlation = supplied !== undefined && supplied.trim() !== '' ? supplied : randomUUID();
  response.setHeader(CORRELATION_ID_HEADER, correlation);
  next();
}

/** Express types a route parameter as `string | string[] | undefined`; these routes only ever get a string. */
function pathParameter(request: Request, name: string): string | undefined {
  const value: unknown = request.params[name];
  return typeof value === 'string' ? value : undefined;
}

/** The replay body is rebuilt from the ledger row, so it is identical to the first response. */
function decrementBody(record: StockDecrementRecord): Record<string, unknown> {
  if (record.unitPriceCents === null || record.totalCents === null || record.remainingStock === null) {
    throw new Error(`The recorded decrement of order ${record.orderId} is missing its recorded numbers`);
  }
  return {
    orderId: record.orderId,
    productId: record.productId,
    quantity: record.quantity,
    unitPriceCents: record.unitPriceCents,
    totalCents: record.totalCents,
    remainingStock: record.remainingStock,
    status: record.outcome,
  };
}

function sendEnvelope(response: Response, error: InventoryRequestError): void {
  response.status(error.status).json({ error: error.message, code: error.code });
}

function errorHandler(dependencies: InventoryHttpDependencies) {
  return (error: unknown, _request: Request, response: Response, next: NextFunction): void => {
    if (response.headersSent) {
      next(error);
      return;
    }
    if (error instanceof InventoryRequestError) {
      sendEnvelope(response, error);
      return;
    }
    if (isJsonBodyParseError(error)) {
      sendEnvelope(response, new InvalidStockDecrementRequestError());
      return;
    }
    const logError = dependencies.logError ?? defaultErrorLogger;
    logError('unhandled failure while serving an inventory request', error);
    response.status(500).json(INTERNAL_ERROR_ENVELOPE);
  };
}

/** `express.json()` rejects malformed payloads with a tagged `SyntaxError`. */
function isJsonBodyParseError(error: unknown): boolean {
  return error instanceof SyntaxError && (error as { type?: unknown }).type === 'entity.parse.failed';
}

function defaultErrorLogger(message: string, error: unknown): void {
  logJson('error', message, errorDetail(error));
}
