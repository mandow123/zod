CREATE TABLE physical_device_products (
  id uuid PRIMARY KEY,
  sku text NOT NULL UNIQUE,
  title text NOT NULL,
  product_type text NOT NULL CHECK (product_type = 'physical_delivery'),
  supplier_display_name text NOT NULL,
  supplier_subject_id uuid REFERENCES trading_subjects(id),
  activation_status text NOT NULL CHECK (activation_status IN ('pending_activation', 'active', 'suspended')),
  inventory_total integer NOT NULL CHECK (inventory_total > 0),
  inventory_reserved integer NOT NULL DEFAULT 0 CHECK (inventory_reserved >= 0),
  inventory_sold integer NOT NULL DEFAULT 0 CHECK (inventory_sold >= 0),
  list_price_cny_micros bigint NOT NULL CHECK (list_price_cny_micros > 0),
  sale_price_cny_micros bigint NOT NULL CHECK (sale_price_cny_micros > 0),
  unit_credit_micros bigint NOT NULL CHECK (unit_credit_micros > 0),
  discount_basis_points integer NOT NULL CHECK (discount_basis_points BETWEEN 1 AND 9999),
  expected_ship_days integer NOT NULL CHECK (expected_ship_days > 0),
  specifications jsonb NOT NULL DEFAULT '{}'::jsonb,
  activated_by_user_id uuid REFERENCES users(id),
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (inventory_reserved + inventory_sold <= inventory_total),
  CHECK (sale_price_cny_micros * 10000 = list_price_cny_micros * discount_basis_points),
  CHECK ((activation_status = 'active') = (
    supplier_subject_id IS NOT NULL AND activated_by_user_id IS NOT NULL AND activated_at IS NOT NULL
  ))
);

INSERT INTO physical_device_products(id, sku, title, product_type, supplier_display_name,
  activation_status, inventory_total, list_price_cny_micros, sale_price_cny_micros,
  unit_credit_micros, discount_basis_points, expected_ship_days, specifications)
VALUES ('02672000-0000-4000-8000-000000000200', 'NVIDIA-DGX-SPARK-200-BAIGE',
  'NVIDIA DGX Spark', 'physical_delivery', '白鸽在线', 'pending_activation', 200,
  40750000000, 32600000000, 32534930140, 8000, 90,
  '{"brand":"NVIDIA","model":"DGX Spark","fulfillment":"preorder","region":"华东-上海","taxIncluded":true}'::jsonb);

CREATE TABLE physical_device_orders (
  id uuid PRIMARY KEY,
  order_number text NOT NULL UNIQUE,
  buyer_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  supplier_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  product_id uuid NOT NULL REFERENCES physical_device_products(id),
  client_request_id text NOT NULL CHECK (char_length(client_request_id) BETWEEN 16 AND 120),
  payload_digest text NOT NULL CHECK (char_length(payload_digest) BETWEEN 16 AND 160),
  shipping_address_reference text NOT NULL CHECK (char_length(shipping_address_reference) BETWEEN 8 AND 160),
  status text NOT NULL CHECK (status IN ('reserved','confirmed','shipping','received','cancelled','expired')),
  quantity integer NOT NULL CHECK (quantity > 0 AND quantity <= 20),
  unit_credit_micros bigint NOT NULL CHECK (unit_credit_micros > 0),
  gross_credit_micros bigint NOT NULL CHECK (gross_credit_micros > 0),
  service_fee_credit_micros bigint CHECK (service_fee_credit_micros >= 0),
  supplier_net_credit_micros bigint CHECK (supplier_net_credit_micros >= 0),
  reservation_transaction_id uuid NOT NULL UNIQUE REFERENCES kai_credit_transactions(id),
  resolution_transaction_id uuid UNIQUE REFERENCES kai_credit_transactions(id),
  reservation_expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  shipped_at timestamptz,
  received_at timestamptz,
  resolved_at timestamptz,
  logistics_provider text,
  tracking_digest text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (buyer_subject_id, client_request_id),
  CHECK (buyer_subject_id <> supplier_subject_id),
  CHECK (gross_credit_micros = unit_credit_micros * quantity),
  CHECK ((status IN ('received','cancelled','expired')) = (resolved_at IS NOT NULL)),
  CHECK ((status IN ('received','cancelled','expired')) = (resolution_transaction_id IS NOT NULL)),
  CHECK ((status = 'received') = (received_at IS NOT NULL)),
  CHECK ((status IN ('shipping','received')) = (shipped_at IS NOT NULL AND logistics_provider IS NOT NULL AND tracking_digest IS NOT NULL)),
  CHECK ((status = 'received') = (service_fee_credit_micros IS NOT NULL AND supplier_net_credit_micros IS NOT NULL)),
  CHECK (status <> 'received' OR supplier_net_credit_micros + service_fee_credit_micros = gross_credit_micros)
);
CREATE INDEX physical_device_orders_buyer_time ON physical_device_orders(buyer_subject_id, created_at DESC, id DESC);
CREATE INDEX physical_device_orders_supplier_time ON physical_device_orders(supplier_subject_id, created_at DESC, id DESC);
CREATE INDEX physical_device_orders_expiry ON physical_device_orders(reservation_expires_at, id) WHERE status = 'reserved';

CREATE TABLE physical_device_order_actions (
  actor_id uuid NOT NULL REFERENCES users(id),
  client_request_id text NOT NULL CHECK (char_length(client_request_id) BETWEEN 16 AND 120),
  order_id uuid NOT NULL REFERENCES physical_device_orders(id),
  action text NOT NULL CHECK (action IN ('confirm','ship','receive','cancel','expire','settle')),
  payload_digest text NOT NULL CHECK (char_length(payload_digest) BETWEEN 16 AND 160),
  result_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, client_request_id)
);

CREATE TABLE physical_device_assets (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES physical_device_orders(id),
  owner_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  product_id uuid NOT NULL REFERENCES physical_device_products(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL CHECK (status = 'owned'),
  acquired_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX physical_device_assets_owner_time ON physical_device_assets(owner_subject_id, acquired_at DESC, id DESC);

CREATE TABLE physical_device_supplier_settlements (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES physical_device_orders(id),
  supplier_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  gross_credit_micros bigint NOT NULL CHECK (gross_credit_micros > 0),
  service_fee_credit_micros bigint NOT NULL CHECK (service_fee_credit_micros >= 0),
  net_credit_micros bigint NOT NULL CHECK (net_credit_micros > 0),
  status text NOT NULL CHECK (status IN ('pending','succeeded')),
  available_at timestamptz NOT NULL,
  settlement_transaction_id uuid UNIQUE REFERENCES kai_credit_transactions(id),
  settled_by_user_id uuid REFERENCES users(id),
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (net_credit_micros + service_fee_credit_micros = gross_credit_micros),
  CHECK ((status = 'succeeded') = (
    settlement_transaction_id IS NOT NULL AND settled_by_user_id IS NOT NULL AND settled_at IS NOT NULL
  )),
  CHECK (settled_at IS NULL OR settled_at >= available_at)
);
CREATE INDEX physical_device_supplier_settlements_due
  ON physical_device_supplier_settlements(available_at, order_id) WHERE status = 'pending';

CREATE TRIGGER physical_device_products_updated_at BEFORE UPDATE ON physical_device_products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER physical_device_orders_updated_at BEFORE UPDATE ON physical_device_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION protect_physical_device_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.order_number <> OLD.order_number OR NEW.buyer_subject_id <> OLD.buyer_subject_id
    OR NEW.supplier_subject_id <> OLD.supplier_subject_id OR NEW.created_by_user_id <> OLD.created_by_user_id
    OR NEW.product_id <> OLD.product_id OR NEW.client_request_id <> OLD.client_request_id
    OR NEW.payload_digest <> OLD.payload_digest OR NEW.shipping_address_reference <> OLD.shipping_address_reference
    OR NEW.quantity <> OLD.quantity OR NEW.unit_credit_micros <> OLD.unit_credit_micros
    OR NEW.gross_credit_micros <> OLD.gross_credit_micros
    OR NEW.reservation_transaction_id <> OLD.reservation_transaction_id
    OR NEW.reservation_expires_at <> OLD.reservation_expires_at OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'physical device order identity is immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'reserved' AND NEW.status IN ('confirmed','cancelled','expired'))
    OR (OLD.status = 'confirmed' AND NEW.status IN ('shipping','cancelled'))
    OR (OLD.status = 'shipping' AND NEW.status = 'received')
  ) THEN RAISE EXCEPTION 'invalid physical device order transition'; END IF;
  IF OLD.resolved_at IS NOT NULL THEN RAISE EXCEPTION 'resolved physical device order is immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER physical_device_orders_guard BEFORE UPDATE ON physical_device_orders
  FOR EACH ROW EXECUTE FUNCTION protect_physical_device_order();
CREATE TRIGGER physical_device_orders_no_delete BEFORE DELETE ON physical_device_orders
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER physical_device_order_actions_immutable BEFORE UPDATE OR DELETE ON physical_device_order_actions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER physical_device_assets_immutable BEFORE UPDATE OR DELETE ON physical_device_assets
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER physical_device_supplier_settlements_no_delete BEFORE DELETE ON physical_device_supplier_settlements
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE FUNCTION protect_physical_device_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.order_id <> OLD.order_id OR NEW.supplier_subject_id <> OLD.supplier_subject_id
    OR NEW.gross_credit_micros <> OLD.gross_credit_micros
    OR NEW.service_fee_credit_micros <> OLD.service_fee_credit_micros
    OR NEW.net_credit_micros <> OLD.net_credit_micros OR NEW.available_at <> OLD.available_at
    OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'physical device settlement identity is immutable'; END IF;
  IF OLD.status <> 'pending' OR NEW.status <> 'succeeded' THEN
    RAISE EXCEPTION 'invalid physical device settlement transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER physical_device_supplier_settlements_guard BEFORE UPDATE ON physical_device_supplier_settlements
  FOR EACH ROW EXECUTE FUNCTION protect_physical_device_settlement();
