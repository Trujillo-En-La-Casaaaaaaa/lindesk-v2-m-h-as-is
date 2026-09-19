-- Notifications database schema (owner: shopflow-notifications). Version 1.
-- This file is authoritative for shopflow-notifications and is applied by shopflow-infra as
-- postgres/notifications-init.sql on a fresh volume. No other repository may apply it.

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type = 'ORDER_CONFIRMATION'),
  order_id TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'DELIVERED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  provider_record_id TEXT,
  occurred_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One logical notification per (type, order id): repeated dispatches from shopflow-orders
  -- can never produce a second provider delivery.
  UNIQUE (type, order_id)
);

CREATE INDEX notifications_pending_idx ON notifications (status, next_attempt_at);

-- Attempt history: evidence for retry, dedupe and reconcile behavior in tests.
CREATE TABLE notification_attempts (
  id BIGSERIAL PRIMARY KEY,
  notification_id TEXT NOT NULL REFERENCES notifications(id),
  attempt INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('DELIVERED', 'PROVIDER_ERROR', 'PROVIDER_TIMEOUT', 'RECONCILED')),
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No seed rows: a fresh notifications database is empty.
