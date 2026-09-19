/** A test HTTP server on an ephemeral loopback port, wired with the production handler. */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

export interface TestServer {
  readonly url: string;
  close(): Promise<void>;
}

export function startTestServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<TestServer> {
  return new Promise<TestServer>((resolve, reject) => {
    const server: Server = createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the test server is not bound to a TCP port'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((done, failed) => {
            server.close((error) => {
              if (error) {
                failed(error);
                return;
              }
              done();
            });
            // Keep-alive sockets of the test client must not hold the teardown open.
            server.closeAllConnections();
          }),
      });
    });
  });
}
