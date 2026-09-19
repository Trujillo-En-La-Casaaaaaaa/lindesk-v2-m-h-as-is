export interface Product { id: string; sku: string; name: string; priceCents: number; stock: number }
export interface Order { id: string; customerEmail: string; status: "CONFIRMED" | "SHIPPED"; productId: string; quantity: number; totalCents: number; createdAt: string }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body as T;
}

export const api = {
  products: () => request<Product[]>("/products"),
  order: (id: string) => request<Order>(`/orders/${encodeURIComponent(id)}`),
  createOrder: (input: { productId: string; quantity: number; customerEmail: string }) =>
    request<Order>("/orders", { method: "POST", body: JSON.stringify(input) }),
  shipOrder: (id: string) => request<Order>(`/admin/orders/${encodeURIComponent(id)}/ship`, { method: "POST" })
};
