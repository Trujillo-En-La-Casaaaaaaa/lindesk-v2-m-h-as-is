/** Tiny HTTP client used by the tests: it reports the status, the headers and the JSON body as-is. */

export interface TestResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly body: unknown;
}

export function jsonRequest(method: string, payload: unknown, headers: Record<string, string> = {}): RequestInit {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json', ...headers } };
  return payload === undefined ? init : { ...init, body: JSON.stringify(payload) };
}

export async function send(baseUrl: string, path: string, init?: RequestInit): Promise<TestResponse> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body: unknown;
  try {
    body = text === '' ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, headers: response.headers, text, body };
}
