-- PG Studio demo database. Usage:  createdb pgstudio_demo && psql -d pgstudio_demo -f scripts/demo.sql
DROP SCHEMA IF EXISTS shop CASCADE;
DROP SCHEMA IF EXISTS analytics CASCADE;
CREATE SCHEMA shop;
CREATE SCHEMA analytics;
COMMENT ON SCHEMA shop IS 'Online store';

CREATE TYPE shop.order_status AS ENUM ('pending', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded');
CREATE DOMAIN shop.email AS text CHECK (VALUE ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$');

CREATE TABLE shop.categories (
  id          serial PRIMARY KEY,
  parent_id   int REFERENCES shop.categories(id) ON DELETE SET NULL,
  name        text NOT NULL UNIQUE,
  slug        text NOT NULL UNIQUE
);
COMMENT ON TABLE shop.categories IS 'Product category tree';

CREATE TABLE shop.customers (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email       shop.email NOT NULL UNIQUE,
  full_name   text NOT NULL,
  country     char(2) NOT NULL DEFAULT 'TW',
  birthday    date,
  is_vip      boolean NOT NULL DEFAULT false,
  tags        text[] NOT NULL DEFAULT '{}',
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz
);
COMMENT ON COLUMN shop.customers.preferences IS 'Arbitrary UI / marketing preferences';
CREATE INDEX customers_country_idx ON shop.customers (country);
CREATE INDEX customers_prefs_gin ON shop.customers USING gin (preferences);

CREATE TABLE shop.products (
  id          serial PRIMARY KEY,
  category_id int NOT NULL REFERENCES shop.categories(id),
  sku         varchar(32) NOT NULL UNIQUE,
  name        text NOT NULL,
  description text,
  price       numeric(12,2) NOT NULL CHECK (price >= 0),
  stock       int NOT NULL DEFAULT 0,
  weight_kg   real,
  attributes  jsonb,
  image       bytea,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_category_idx ON shop.products (category_id);

CREATE TABLE shop.orders (
  id          bigserial PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES shop.customers(id) ON DELETE CASCADE,
  status      shop.order_status NOT NULL DEFAULT 'pending',
  total       numeric(12,2) NOT NULL DEFAULT 0,
  shipping_address text,
  note        text,
  placed_at   timestamptz NOT NULL DEFAULT now(),
  shipped_at  timestamptz
);
CREATE INDEX orders_customer_idx ON shop.orders (customer_id);
CREATE INDEX orders_placed_idx ON shop.orders (placed_at DESC);

CREATE TABLE shop.order_items (
  order_id    bigint NOT NULL REFERENCES shop.orders(id) ON DELETE CASCADE,
  line_no     int NOT NULL,
  product_id  int NOT NULL REFERENCES shop.products(id),
  quantity    int NOT NULL CHECK (quantity > 0),
  unit_price  numeric(12,2) NOT NULL,
  PRIMARY KEY (order_id, line_no)
);

CREATE TABLE shop.reviews (
  id          serial PRIMARY KEY,
  product_id  int NOT NULL REFERENCES shop.products(id) ON DELETE CASCADE,
  customer_id bigint REFERENCES shop.customers(id) ON DELETE SET NULL,
  rating      smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A table without primary key (grid editing must handle this as read-only or ctid)
CREATE TABLE shop.audit_log (
  at      timestamptz NOT NULL DEFAULT now(),
  actor   text,
  action  text NOT NULL,
  payload jsonb
);

-- Partitioned table
CREATE TABLE analytics.page_views (
  id        bigserial,
  viewed_at timestamptz NOT NULL,
  path      text NOT NULL,
  customer_id bigint,
  duration_ms int,
  PRIMARY KEY (id, viewed_at)
) PARTITION BY RANGE (viewed_at);
CREATE TABLE analytics.page_views_2026h1 PARTITION OF analytics.page_views FOR VALUES FROM ('2026-01-01') TO ('2026-07-01');
CREATE TABLE analytics.page_views_2026h2 PARTITION OF analytics.page_views FOR VALUES FROM ('2026-07-01') TO ('2027-01-01');

-- Functions / procedures / triggers
CREATE FUNCTION shop.touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER customers_touch BEFORE UPDATE ON shop.customers FOR EACH ROW EXECUTE FUNCTION shop.touch_updated_at();

CREATE FUNCTION shop.order_total(p_order_id bigint) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(sum(quantity * unit_price), 0) FROM shop.order_items WHERE order_id = p_order_id
$$;
COMMENT ON FUNCTION shop.order_total(bigint) IS 'Sum of order lines';

CREATE PROCEDURE shop.cancel_order(p_order_id bigint) LANGUAGE plpgsql AS $$
BEGIN
  UPDATE shop.orders SET status = 'cancelled' WHERE id = p_order_id;
  INSERT INTO shop.audit_log(actor, action, payload) VALUES (current_user, 'cancel_order', jsonb_build_object('order_id', p_order_id));
END $$;

-- Data
INSERT INTO shop.categories (name, slug) VALUES ('Electronics','electronics'),('Books','books'),('Home','home'),('Outdoor','outdoor'),('Toys','toys');
INSERT INTO shop.categories (parent_id, name, slug) VALUES (1,'Laptops','laptops'),(1,'Phones','phones'),(2,'Fiction','fiction'),(3,'Kitchen','kitchen');

INSERT INTO shop.customers (email, full_name, country, birthday, is_vip, tags, preferences, created_at)
SELECT 'user' || g || '@example.com',
       (ARRAY['Alice','Bob','Chen','Diana','Eve','Frank','Grace','Hiro','Ivy','Jun','Kai','Lin','Mei','Noah','Olga','Pablo'])[1 + g % 16] || ' ' ||
       (ARRAY['Wang','Smith','Lee','Garcia','Tanaka','Kim','Müller','Rossi','Chen','Lin'])[1 + (g * 7) % 10],
       (ARRAY['TW','US','JP','DE','FR','GB','KR','SG'])[1 + g % 8],
       DATE '1960-01-01' + (g * 37 % 15000),
       g % 13 = 0,
       CASE WHEN g % 5 = 0 THEN ARRAY['newsletter','beta'] WHEN g % 3 = 0 THEN ARRAY['wholesale'] ELSE '{}' END,
       jsonb_build_object('theme', CASE WHEN g % 2 = 0 THEN 'dark' ELSE 'light' END, 'lang', (ARRAY['zh-TW','en','ja'])[1 + g % 3], 'marketing', g % 4 = 0),
       now() - (g || ' hours')::interval
  FROM generate_series(1, 5000) g;

INSERT INTO shop.products (category_id, sku, name, description, price, stock, weight_kg, attributes, active)
SELECT 1 + g % 9, 'SKU-' || lpad(g::text, 5, '0'),
       (ARRAY['Ultra','Pro','Mini','Max','Air','Classic','Smart','Eco'])[1 + g % 8] || ' ' ||
       (ARRAY['Widget','Gadget','Lamp','Kettle','Novel','Tent','Robot','Phone','Laptop','Speaker'])[1 + g % 10] || ' ' || g,
       CASE WHEN g % 4 = 0 THEN NULL ELSE 'A great product. Line one.' || E'\n' || 'Line two with ''quotes''.' END,
       round((5 + random() * 995)::numeric, 2), (random() * 500)::int, round((random() * 10)::numeric, 2),
       jsonb_build_object('color', (ARRAY['red','green','blue','black','white'])[1 + g % 5], 'size', (ARRAY['S','M','L','XL'])[1 + g % 4]),
       g % 17 <> 0
  FROM generate_series(1, 800) g;

INSERT INTO shop.orders (customer_id, status, shipping_address, note, placed_at, shipped_at)
SELECT 1 + (g * 31) % 5000,
       (ARRAY['pending','paid','shipped','delivered','delivered','delivered','cancelled','refunded'])[1 + g % 8]::shop.order_status,
       g || ' Main Street, Taipei',
       CASE WHEN g % 10 = 0 THEN 'Leave at the door' END,
       now() - ((g % 365) || ' days')::interval - ((g % 24) || ' hours')::interval,
       CASE WHEN g % 8 IN (2,3,4,5) THEN now() - ((g % 365) || ' days')::interval + interval '2 days' END
  FROM generate_series(1, 60000) g;

INSERT INTO shop.order_items (order_id, line_no, product_id, quantity, unit_price)
SELECT o.id, l, 1 + (o.id * 13 + l * 7) % 800, 1 + (o.id + l) % 4, p.price
  FROM shop.orders o
  CROSS JOIN generate_series(1, 3) l
  JOIN shop.products p ON p.id = 1 + (o.id * 13 + l * 7) % 800
 WHERE l <= 1 + o.id % 3;

UPDATE shop.orders o SET total = shop.order_total(o.id);

INSERT INTO shop.reviews (product_id, customer_id, rating, body)
SELECT 1 + g % 800, 1 + g % 5000, 1 + g % 5, CASE WHEN g % 3 = 0 THEN 'Love it!' WHEN g % 3 = 1 THEN 'It is ok.' END
  FROM generate_series(1, 4000) g;

INSERT INTO shop.audit_log (actor, action, payload)
SELECT 'system', 'import', jsonb_build_object('batch', g) FROM generate_series(1, 50) g;

INSERT INTO analytics.page_views (viewed_at, path, customer_id, duration_ms)
SELECT TIMESTAMPTZ '2026-01-01' + (g * interval '4 minutes'), (ARRAY['/','/products','/cart','/checkout','/account'])[1 + g % 5],
       CASE WHEN g % 3 = 0 THEN NULL ELSE 1 + g % 5000 END, (random() * 60000)::int
  FROM generate_series(1, 100000) g;

-- Views
CREATE VIEW shop.order_summary AS
SELECT o.id, c.full_name AS customer, c.country, o.status, o.total, o.placed_at, count(i.*) AS lines
  FROM shop.orders o JOIN shop.customers c ON c.id = o.customer_id
  LEFT JOIN shop.order_items i ON i.order_id = o.id
 GROUP BY o.id, c.full_name, c.country;

CREATE MATERIALIZED VIEW analytics.daily_revenue AS
SELECT date_trunc('day', placed_at)::date AS day, count(*) AS orders, sum(total) AS revenue
  FROM shop.orders WHERE status NOT IN ('cancelled','refunded')
 GROUP BY 1 ORDER BY 1;

-- public schema sample too
CREATE TABLE IF NOT EXISTS public.notes (
  id serial PRIMARY KEY,
  title text NOT NULL,
  body text,
  done boolean DEFAULT false,
  created_at timestamp DEFAULT now()
);
TRUNCATE public.notes;
INSERT INTO public.notes (title, body, done) VALUES
 ('Welcome to PG Studio', 'Double-click a cell to edit it.', false),
 ('中文測試', '支援 Unicode 與 emoji 🐘', true),
 ('Multi-line', E'first line\nsecond line', false);

ANALYZE;
