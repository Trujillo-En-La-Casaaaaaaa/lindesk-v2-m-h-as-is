-- Orders database schema (owner: shopflow-orders). Version 1.
-- This file is authoritative for shopflow-orders and is applied by shopflow-infra as
-- postgres/orders-init.sql on a fresh volume. No other repository may apply or modify it.

CREATE TABLE orders (
  id UUID PRIMARY KEY,
  customer_email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('CONFIRMED', 'SHIPPED')),
  -- Reference to an inventory-owned product. Intentionally NOT a foreign key: the product row
  -- lives in another service's database (see ADR-0003). Integrity is guaranteed by the
  -- order-creation saga: an order exists only after inventory recorded a decrement for this id.
  product_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX orders_status_idx ON orders (status);

-- Order-creation saga: one durable row per creation intent, written before any remote call.
CREATE TABLE order_operations (
  order_id UUID PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN (
    'STARTED', 'DECREMENTED', 'COMPLETED', 'ABORTED_NOT_FOUND', 'ABORTED_INSUFFICIENT_STOCK', 'UNCERTAIN'
  )),
  product_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  customer_email TEXT NOT NULL,
  client_idempotency_key TEXT UNIQUE,
  unit_price_cents INTEGER,
  decrement_outcome TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX order_operations_state_idx ON order_operations (state, updated_at);

-- Durable notification intent. Written in the same transaction as the order row so a committed
-- order can never lose its confirmation (see ADR-0006).
CREATE TABLE notification_outbox (
  id BIGSERIAL PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id),
  type TEXT NOT NULL CHECK (type = 'ORDER_CONFIRMATION'),
  payload JSONB NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'DELIVERED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (type, order_id)
);

CREATE INDEX notification_outbox_pending_idx ON notification_outbox (state, next_attempt_at);

-- No seed rows: a fresh orders database is empty, exactly like the legacy orders table before
-- the first order was placed.
