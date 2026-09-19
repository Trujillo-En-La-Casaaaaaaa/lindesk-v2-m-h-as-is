/**
 * A test double of the external notification provider emulator (owned by `shopflow-infra`), used to
 * drive the delivery branch of `shopflow-notifications` in the integration tests.
 *
 * It speaks the unchanged provider contract - `POST /notifications` answers
 * `201 {"id":"notification-NNNN", ...message}`, `GET /notifications` lists what it accepted,
 * `GET /health` is liveness - and it can be switched off (`stopListening`) and switched back on, so
 * the "the confirmation cannot be delivered right now" scenario is reproducible.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ProviderRecord {
  readonly id: string;
  readonly type: string;
  readonly orderId: string;
  readonly customerEmail: string;
}

export class StubProvider {
  readonly records: ProviderRecord[] = [];
  readonly requests: { method: string; path: string; body: unknown }[] = [];

  private server: Server | null = null;
  private port = 0;
  private sequence = 0;
  private listening = false;

  get baseUrl(): string {
    if (!this.listening) {
      throw new Error('the provider stub is not listening');
    }
    return `http://127.0.0.1:${this.port}`;
  }

  get postCount(): number {
    return this.requests.filter((request) => request.method === 'POST' && request.path === '/notifications').length;
  }

  recordsForOrder(orderId: string): ProviderRecord[] {
    return this.records.filter((record) => record.orderId === orderId);
  }

  reset(): void {
    this.records.length = 0;
    this.requests.length = 0;
    this.sequence = 0;
  }

  /** Listens again, reusing the port of the previous session unless another one is requested. */
  async start(port = this.port): Promise<void> {
    if (this.listening) {
      return;
    }
    const server =
      this.server ??
      createServer((request, response) => {
        void this.handle(request, response).catch(() => undefined);
      });
    this.server = server;
    server.on('connection', (socket) => {
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    this.port = (server.address() as AddressInfo).port;
    this.listening = true;
  }

  /** Makes the provider unreachable, keeping its records and its port. */
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

  async stop(): Promise<void> {
    await this.stopListening();
    this.server?.closeAllConnections();
    this.server = null;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const raw = await readBody(request);
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    let body: unknown = null;
    if (raw !== '') {
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
    }
    this.requests.push({ method: request.method ?? 'GET', path, body });

    if (response.writableEnded || response.destroyed) {
      return;
    }
    if (request.method === 'GET' && path === '/health') {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === 'GET' && path === '/notifications') {
      sendJson(response, 200, this.records.map((record) => ({ ...record })));
      return;
    }
    if (request.method === 'POST' && path === '/notifications') {
      this.handlePost(response, body);
      return;
    }
    sendJson(response, 404, { error: 'Not found' });
  }

  private handlePost(response: ServerResponse, body: unknown): void {
    if (!isRecord(body) || body['type'] !== 'ORDER_CONFIRMATION' || typeof body['orderId'] !== 'string') {
      sendJson(response, 400, { error: 'Invalid notification' });
      return;
    }
    this.sequence += 1;
    const record: ProviderRecord = {
      id: `notification-${String(this.sequence).padStart(4, '0')}`,
      type: 'ORDER_CONFIRMATION',
      orderId: body['orderId'],
      customerEmail: typeof body['customerEmail'] === 'string' ? body['customerEmail'] : '',
    };
    this.records.push(record);
    sendJson(response, 201, record);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.writableEnded || response.destroyed || response.socket === null) {
    return;
  }
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
