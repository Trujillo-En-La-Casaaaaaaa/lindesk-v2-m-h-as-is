/**
 * The public route table, expressed as declarative data (see
 * `design/gateway-routing-table.md`).
 *
 * This module is the only place where the public surface is described: five public
 * routes, their owning service and the upstream path they map to. No handler logic,
 * no domain rules.
 */
export type UpstreamName = 'orders' | 'inventory';
export type HttpMethod = 'GET' | 'POST';

export interface GatewayRoute {
  /** Method on the public surface. */
  readonly method: HttpMethod;
  /** Express path on the public surface (legacy public path, without the browser's `/api` prefix). */
  readonly publicPath: string;
  /** Service that owns the operation, or `gateway` for the local liveness route. */
  readonly owner: UpstreamName | 'gateway';
  /** Upstream path template, `null` for the local liveness route. */
  readonly upstreamPathTemplate: string | null;
  /** Method used on the upstream service. */
  readonly upstreamMethod: HttpMethod | null;
  /**
   * `true` only for the two safe reads. Those may be retried once on a connection
   * failure; the three writes are never retried.
   */
  readonly retryOnConnectionFailure: boolean;
}

export const ROUTE_TABLE: readonly GatewayRoute[] = [
  {
    method: 'GET',
    publicPath: '/health',
    owner: 'gateway',
    upstreamPathTemplate: null,
    upstreamMethod: null,
    retryOnConnectionFailure: false,
  },
  {
    method: 'GET',
    publicPath: '/products',
    owner: 'inventory',
    upstreamPathTemplate: '/products',
    upstreamMethod: 'GET',
    retryOnConnectionFailure: true,
  },
  {
    method: 'POST',
    publicPath: '/orders',
    owner: 'orders',
    upstreamPathTemplate: '/orders',
    upstreamMethod: 'POST',
    retryOnConnectionFailure: false,
  },
  {
    method: 'GET',
    publicPath: '/orders/:id',
    owner: 'orders',
    upstreamPathTemplate: '/orders/:id',
    upstreamMethod: 'GET',
    retryOnConnectionFailure: true,
  },
  {
    // The single rewrite of the public surface: the legacy admin path becomes the
    // owner-service path (see `apis/dependency-orders-api.md`).
    method: 'POST',
    publicPath: '/admin/orders/:id/ship',
    owner: 'orders',
    upstreamPathTemplate: '/orders/:id/ship',
    upstreamMethod: 'POST',
    retryOnConnectionFailure: false,
  },
];

export const PROXY_ROUTES: readonly GatewayRoute[] = ROUTE_TABLE.filter((route) => route.owner !== 'gateway');

/**
 * Looks up a declared route. The HTTP adapter uses this so that the express registration is
 * explicit (five literal routes) while this table stays the single source of truth: a
 * registration that is not declared here fails fast on startup.
 */
export function findRoute(method: HttpMethod, publicPath: string): GatewayRoute {
  const route = ROUTE_TABLE.find(
    (candidate) => candidate.method === method && candidate.publicPath === publicPath,
  );
  if (route === undefined) {
    throw new Error(`route ${method} ${publicPath} is not declared in the gateway route table`);
  }
  return route;
}

/** Resolves `:id`-style placeholders into the upstream path. */
export function resolveUpstreamPath(
  template: string,
  params: Readonly<Record<string, string | undefined>>,
): string {
  return template.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`route parameter "${name}" is missing for upstream path "${template}"`);
    }
    return encodeURIComponent(value);
  });
}
