CREATE TABLE products (
  id TEXT PRIMARY KEY,
  sku TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  stock INTEGER NOT NULL CHECK (stock >= 0)
);

CREATE TABLE orders (
  id UUID PRIMARY KEY,
  customer_email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('CONFIRMED', 'SHIPPED')),
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  created_at TIMESTAMPTZ NOT NULL
);

INSERT INTO products (id, sku, name, price_cents, stock) VALUES
  ('product-a', 'SKU-A', 'Product A', 1200, 10),
  ('product-b', 'SKU-B', 'Product B', 2500, 5);
