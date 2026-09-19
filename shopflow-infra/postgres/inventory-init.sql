-- Inventory database schema (owner: shopflow-inventory). Version 1.
-- This file is authoritative for shopflow-inventory and is applied by shopflow-infra as
-- postgres/inventory-init.sql on a fresh volume. No other repository may apply or modify it.

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  sku TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  stock INTEGER NOT NULL CHECK (stock >= 0)
);

-- Idempotency ledger: one row per order id that reached POST /stock-decrements.
-- A repeated call reads this row and replays the recorded outcome instead of mutating stock again.
CREATE TABLE stock_decrements (
  order_id UUID PRIMARY KEY,
  product_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('DECREMENTED', 'INSUFFICIENT_STOCK', 'NOT_FOUND')),
  state TEXT NOT NULL CHECK (state IN ('RECORDED', 'RELEASED')),
  unit_price_cents INTEGER,
  total_cents INTEGER,
  remaining_stock INTEGER,
  attempts INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT released_requires_a_decrement CHECK (state <> 'RELEASED' OR outcome = 'DECREMENTED')
);

CREATE INDEX stock_decrements_state_idx ON stock_decrements (state, updated_at);

-- Deterministic seed, preserved verbatim from the legacy shared database.
INSERT INTO products (id, sku, name, price_cents, stock) VALUES
  ('product-a', 'SKU-A', 'Product A', 1200, 10),
  ('product-b', 'SKU-B', 'Product B', 2500, 5);
