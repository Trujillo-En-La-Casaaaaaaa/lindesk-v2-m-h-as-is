import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Express } from 'express';

export interface TestHttpServer {
  readonly server: Server;
  readonly baseUrl: string;
  close(): Promise<void>;
}

export async function startTestHttpServer(app: Express): Promise<TestHttpServer> {
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

export interface JsonResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: any;
  readonly text: string;
}

async function toJsonResponse(response: Response): Promise<JsonResponse> {
  const text = await response.text();
  let body: unknown = null;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { status: response.status, headers: response.headers, body, text };
}

export async function getJson(baseUrl: string, path: string, headers: Record<string, string> = {}): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`, { method: 'GET', headers });
  return toJsonResponse(response);
}

export async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return toJsonResponse(response);
}

export async function postRaw(
  baseUrl: string,
  path: string,
  rawBody: string,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: rawBody,
  });
  return toJsonResponse(response);
}
