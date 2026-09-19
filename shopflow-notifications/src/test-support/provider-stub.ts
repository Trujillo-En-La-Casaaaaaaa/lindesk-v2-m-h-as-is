import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ReceivedProviderRequest {
  readonly method: string;
  readonly path: string;
  readonly contentType: string | null;
  readonly rawBody: string;
  readonly body: unknown;
  readonly receivedAt: string;
}

export interface StubProviderNotification {
  readonly id: string;
  readonly type: string;
  readonly orderId: string;
  readonly customerEmail: string;
}

interface StubProviderOptions {
  readonly initialDelayMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Test double for the unchanged provider emulator owned by `shopflow-infra`:
 *
 * - `POST /notifications` requires `type === 'ORDER_CONFIRMATION'` and a truthy
 *   `orderId`, answers `201 {"id":"notification-NNNN", ...payload}`
 * - `GET /notifications` is the inspection endpoint used for reconcile checks
 * - `GET /health`
 *
 * Like the real emulator it has no idempotency key and does not deduplicate, so a
 * second POST for the same order id really does create a second record. It can be
 * switched off (provider unreachable), made to fail, made to answer slowly
 * (timeout) or made to accept a message while dropping the response (ambiguous
 * failure).
 */
export class StubNotificationProvider {
  readonly requests: ReceivedProviderRequest[] = [];
  readonly notifications: StubProviderNotification[] = [];

  private server: Server | null = null;
  private port = 0;
  private sequence = 0;
  private dropResponseCount = 0;
  private failCount = 0;
  private responseDelayMs: number;
  private listening = false;

  constructor(options: StubProviderOptions = {}) {
    this.responseDelayMs = options.initialDelayMs ?? 0;
  }

  get baseUrl(): string {
    if (!this.listening) {
      throw new Error('provider stub is not listening');
    }
    return `http://127.0.0.1:${this.port}`;
  }

  get isListening(): boolean {
    return this.listening;
  }

  get postCount(): number {
    return this.requests.filter((request) => request.method === 'POST' && request.path === '/notifications').length;
  }

  postedBodies(): Record<string, unknown>[] {
    return this.requests
      .filter((request) => request.method === 'POST' && request.path === '/notifications')
      .map((request) => (isRecord(request.body) ? request.body : {}));
  }

  postsForOrder(orderId: string): ReceivedProviderRequest[] {
    return this.requests.filter(
      (request) => request.method === 'POST' && request.path === '/notifications' && isRecord(request.body) && request.body.orderId === orderId,
    );
  }

  notificationsForOrder(orderId: string): StubProviderNotification[] {
    return this.notifications.filter((notification) => notification.orderId === orderId);
  }

  /** Accept the next `count` POSTs but drop the response (lost in transit). */
  setDropNextResponses(count: number): void {
    this.dropResponseCount = count;
  }

  /** Answer the next `count` POSTs with `503` (provider error). */
  setFailNextRequests(count: number): void {
    this.failCount = count;
  }

  /** Delay every response by `delayMs` (used to exercise the 3 s timeout). */
  setResponseDelayMs(delayMs: number): void {
    this.responseDelayMs = delayMs;
  }

  /** Simulates a message the provider holds although this service never saw a 2xx. */
  seedNotification(input: { type?: string; orderId: string; customerEmail?: string }): StubProviderNotification {
    this.sequence += 1;
    const notification: StubProviderNotification = {
      id: `notification-${String(this.sequence).padStart(4, '0')}`,
      type: input.type ?? 'ORDER_CONFIRMATION',
      orderId: input.orderId,
      customerEmail: input.customerEmail ?? 'buyer@example.com',
    };
    this.notifications.push(notification);
    return notification;
  }

  reset(): void {
    this.requests.length = 0;
    this.notifications.length = 0;
    this.sequence = 0;
    this.dropResponseCount = 0;
    this.failCount = 0;
    this.responseDelayMs = 0;
  }

  async start(port = 0): Promise<number> {
    if (this.listening) {
      return this.port;
    }
    const server = this.server ?? createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        // A client that aborted (timeout test) must never break the stub.
      });
    });
    this.server = server;
    server.on('connection', (socket) => {
      socket.on('error', () => undefined);
    });
    server.on('clientError', (_error, socket) => {
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    this.port = address.port;
    this.listening = true;
    return this.port;
  }

  /** Makes the provider unreachable (connection refused), keeping its state. */
  async stopListening(): Promise<void> {
    const server = this.server;
    if (server === null || !this.listening) {
      return;
    }
    this.listening = false;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  async ensureListening(): Promise<void> {
    if (!this.listening) {
      await this.start(this.port);
    }
  }

  async stop(): Promise<void> {
    await this.stopListening();
    this.server?.closeAllConnections();
    this.server = null;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const rawBody = await readRequestBody(request);
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    let body: unknown = null;
    if (rawBody !== '') {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = null;
      }
    }

    this.requests.push({
      method: request.method ?? 'GET',
      path,
      contentType: request.headers['content-type'] ?? null,
      rawBody,
      body,
      receivedAt: new Date().toISOString(),
    });

    if (this.responseDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.responseDelayMs));
    }

    if (response.writableEnded || response.destroyed) {
      return;
    }

    if (request.method === 'GET' && path === '/health') {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'GET' && path === '/notifications') {
      sendJson(response, 200, this.notifications.map((notification) => ({ ...notification })));
      return;
    }

    if (request.method === 'POST' && path === '/notifications') {
      this.handlePost(response, body);
      return;
    }

    sendJson(response, 404, { error: 'not found' });
  }

  private handlePost(response: ServerResponse, body: unknown): void {
    if (this.failCount > 0) {
      this.failCount -= 1;
      sendJson(response, 503, { error: 'provider unavailable' });
      return;
    }

    if (!isRecord(body) || body.type !== 'ORDER_CONFIRMATION' || typeof body.orderId !== 'string' || body.orderId === '') {
      sendJson(response, 400, { error: 'invalid notification' });
      return;
    }

    const notification = this.seedNotification({
      type: 'ORDER_CONFIRMATION',
      orderId: body.orderId,
      customerEmail: typeof body.customerEmail === 'string' ? body.customerEmail : '',
    });

    if (this.dropResponseCount > 0) {
      // The provider accepted the message, the response never reaches the caller.
      this.dropResponseCount -= 1;
      response.writeHead(201, { 'content-type': 'application/json', 'content-length': '512' });
      response.flushHeaders();
      response.socket?.destroy();
      return;
    }

    sendJson(response, 201, { id: notification.id, ...body });
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.writableEnded || response.socket === null || response.destroyed) {
    return;
  }
  const body = JSON.stringify(payload);
  try {
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    response.end(body);
  } catch {
    // The caller aborted the request (timeout test).
  }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of request) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
  } catch {
    return Buffer.concat(chunks).toString('utf8');
  }
  return Buffer.concat(chunks).toString('utf8');
}
