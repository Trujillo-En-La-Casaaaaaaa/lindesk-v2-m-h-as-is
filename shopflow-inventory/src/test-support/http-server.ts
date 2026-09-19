import type { IncomingMessage, Server } from 'node:http';
import { createServer } from 'node:http';

/** A test server bound to an ephemeral loopback port, with the same handler wiring as production. */
export interface TestServer {
  readonly url: string;
  close(): Promise<void>;
}

export async function startTestServer(
  handler: (request: IncomingMessage, response: import('node:http').ServerResponse) => void,
): Promise<TestServer> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The test server is not bound to a TCP port');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
        // Keep-alive sockets of the test client must not hold the teardown open.
        server.closeAllConnections();
      }),
  };
}
