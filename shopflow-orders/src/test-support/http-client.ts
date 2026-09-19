/** A tiny HTTP client for the tests: status, headers and JSON body exactly as they arrived. */

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

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until the predicate returns something truthy, or throws with the last observation. */
export async function waitFor<T>(
  predicate: () => Promise<T | undefined>,
  { timeoutMs = 10_000, intervalMs = 25, description = 'the condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(`${description} was not observed within ${timeoutMs} ms`);
    }
    await delay(intervalMs);
  }
}
