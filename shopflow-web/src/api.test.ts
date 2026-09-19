import assert from "node:assert/strict";
import { afterEach, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => vi.unstubAllGlobals());

it("creates orders through the API HTTP boundary", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "order-1", status: "CONFIRMED" }), {
    status: 201,
    headers: { "content-type": "application/json" }
  }));
  vi.stubGlobal("fetch", fetchMock);
  await api.createOrder({ productId: "product-a", quantity: 2, customerEmail: "buyer@example.com" });
  assert.equal(fetchMock.mock.calls[0][0], "/api/orders");
  assert.equal(fetchMock.mock.calls[0][1].method, "POST");
});
