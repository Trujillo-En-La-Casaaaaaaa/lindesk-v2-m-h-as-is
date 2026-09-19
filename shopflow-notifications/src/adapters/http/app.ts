import express from 'express';
import type { NextFunction, Request, Response } from 'express';

import {
  idempotencyKeyForOrderConfirmation,
  parseOrderConfirmationIntent,
  toNotificationView,
} from '../../domain/notification.js';
import type { NotificationRepository } from '../../ports/notification-repository.js';
import type { NotificationDeliveryService } from '../../application/notification-delivery-service.js';
import { silentLogger, type Logger } from '../../observability/logger.js';

export interface NotificationAppDependencies {
  readonly repository: NotificationRepository;
  readonly delivery: NotificationDeliveryService;
  readonly logger?: Logger;
}

export const ERROR_CODES = {
  invalid: 'INVALID',
  providerUnavailable: 'PROVIDER_UNAVAILABLE',
  internal: 'INTERNAL',
  notFound: 'NOT_FOUND',
} as const;

function sendError(response: Response, status: number, error: string, code: string): void {
  // Error envelope, exactly two fields: {"error", "code"}.
  response.status(status).json({ error, code });
}

function bodyParserStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const candidate = (error as { status?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;
  if (typeof candidate === 'number' && candidate >= 400 && candidate < 500) {
    return candidate;
  }
  return null;
}

/**
 * HTTP surface of `apis/notifications-service-api.md` version 1:
 * `GET /health`, `POST /notifications/order-confirmations`, `GET /notifications`.
 * JSON only; every error uses the two-field envelope; `x-correlation-id` is echoed.
 */
export function createNotificationApp(dependencies: NotificationAppDependencies): express.Express {
  const logger = dependencies.logger ?? silentLogger;
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.use((request: Request, response: Response, next: NextFunction) => {
    const correlationId = request.get('x-correlation-id');
    if (typeof correlationId === 'string' && correlationId !== '') {
      response.set('x-correlation-id', correlationId);
    }
    next();
  });

  // Liveness only: never calls the provider (and needs no database round trip).
  app.get('/health', (_request: Request, response: Response) => {
    response.status(200).json({ ok: true });
  });

  app.get('/notifications', async (_request: Request, response: Response) => {
    const records = await dependencies.repository.list();
    response.status(200).json(records.map(toNotificationView));
  });

  app.post('/notifications/order-confirmations', async (request: Request, response: Response) => {
    const parsed = parseOrderConfirmationIntent(request.body);
    if (!parsed.ok) {
      logger.info('rejected invalid notification intent', { reason: parsed.reason });
      sendError(response, 400, 'Invalid notification', ERROR_CODES.invalid);
      return;
    }

    const idempotencyKey = request.get('idempotency-key');
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() !== idempotencyKeyForOrderConfirmation(parsed.intent.orderId)) {
      logger.info('rejected mismatching idempotency key', { orderId: parsed.intent.orderId });
      sendError(response, 400, 'Invalid notification', ERROR_CODES.invalid);
      return;
    }

    const outcome = await dependencies.delivery.dispatchOrderConfirmation(parsed.intent);

    switch (outcome.kind) {
      case 'sent':
        response.status(201).json(toNotificationView(outcome.record));
        return;
      case 'delivered-on-retry':
      case 'idempotent-replay':
        response.status(200).set('x-idempotent-replay', 'true').json(toNotificationView(outcome.record));
        return;
      case 'provider-failure':
        sendError(response, 502, 'Notification provider unavailable', ERROR_CODES.providerUnavailable);
        return;
    }
  });

  app.use((_request: Request, response: Response) => {
    sendError(response, 404, 'Not found', ERROR_CODES.notFound);
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (response.headersSent) {
      return;
    }
    const status = bodyParserStatus(error);
    if (status !== null) {
      sendError(response, status, status === 413 ? 'Request body too large' : 'Invalid notification', ERROR_CODES.invalid);
      return;
    }
    logger.error('unhandled notification request error', { error: error instanceof Error ? error.message : String(error) });
    sendError(response, 500, 'Internal server error', ERROR_CODES.internal);
  });

  return app;
}
