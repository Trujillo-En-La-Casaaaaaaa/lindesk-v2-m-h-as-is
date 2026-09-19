/**
 * Local HTTP stubs for the owning services, used by the gateway unit/integration tests.
 *
 * These stubs stand in for `shopflow-orders` and `shopflow-inventory` only; they are test
 * infrastructure, never a runtime fallback of the gateway.
 */
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface StubResponse {
  readonly status: number;
  readonly body: string;
  readonly contentType?: string;
}

export type StubResponder = (request: RecordedRequest) => StubResponse | Promise<StubResponse>;

export interface StubServer {
  readonly url: string;
  readonly port: number;
  readonly requests: RecordedRequest[];
  respond(responder: StubResponder): void;
  close(): Promise<void>;
}

/** Accepts connections and drops them without answering: models a connection failure. */
export interface DroppingServer {
  readonly url: string;
  attempts(): number;
  resetAttempts(): void;
  close(): Promise<void>;
}

export function listenServer(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeAllConnections();
  });
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

export async function startStubServer(responder: StubResponder): Promise<StubServer> {
  const requests: RecordedRequest[] = [];
  let currentResponder = responder;

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const body = await readBody(request);
        const recorded: RecordedRequest = {
          method: request.method ?? '',
          url: request.url ?? '',
          headers: request.headers,
          body,
        };
        requests.push(recorded);
        const stubResponse = await currentResponder(recorded);
        response.writeHead(stubResponse.status, {
          'content-type': stubResponse.contentType ?? 'application/json',
        });
        response.end(stubResponse.body);
      } catch {
        // The client gave up (timeout tests) - there is nothing to answer.
        response.destroy();
      }
    })();
  });
  server.on('clientError', (_error, socket) => {
    socket.destroy();
  });

  const port = await listenServer(server);
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    respond: (next: StubResponder) => {
      currentResponder = next;
    },
    close: () => closeServer(server),
  };
}

export async function startDroppingServer(): Promise<DroppingServer> {
  let attempts = 0;
  const server = createServer();
  server.on('request', (request, response) => {
    attempts += 1;
    void readBody(request).finally(() => {
      response.socket?.destroy();
    });
  });
  server.on('clientError', (_error, socket) => {
    socket.destroy();
  });

  const port = await listenServer(server);
  return {
    url: `http://127.0.0.1:${port}`,
    attempts: () => attempts,
    resetAttempts: () => {
      attempts = 0;
    },
    close: () => closeServer(server),
  };
}

/** Reserves an ephemeral port and releases it, leaving nothing listening on it. */
export async function reserveClosedPort(): Promise<number> {
  const server = createServer();
  const port = await listenServer(server);
  await closeServer(server);
  return port;
}
