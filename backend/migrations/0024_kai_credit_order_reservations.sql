CREATE TABLE kai_credit_order_requests (
  buyer_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  client_request_id text NOT NULL CHECK (char_length(client_request_id) BETWEEN 16 AND 120),
  payload_digest text NOT NULL CHECK (char_length(payload_digest) BETWEEN 16 AND 160),
  state text NOT NULL DEFAULT 'processing' CHECK (state IN ('processing', 'retryable', 'completed')),
  order_id uuid,
  last_result text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (buyer_subject_id, client_request_id),
  CHECK ((state = 'completed') = (order_id IS NOT NULL))
);

CREATE TABLE kai_credit_orders (
  id uuid PRIMARY KEY,
  order_number text NOT NULL UNIQUE CHECK (char_length(order_number) BETWEEN 12 AND 40),
  buyer_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  supplier_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  listing_id uuid NOT NULL REFERENCES credit_market_listings(id),
  client_request_id text NOT NULL CHECK (char_length(client_request_id) BETWEEN 16 AND 120),
  payload_digest text NOT NULL CHECK (char_length(payload_digest) BETWEEN 16 AND 160),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN (
    'reserved', 'confirmed', 'provisioning', 'ready', 'in_service', 'acceptance_pending', 'accepted',
    'cancelled', 'expired', 'release_pending', 'refund_pending', 'refunded', 'disputed', 'closed'
  )),
  quantity numeric(24,6) NOT NULL CHECK (quantity > 0),
  capacity_unit text NOT NULL CHECK (char_length(capacity_unit) BETWEEN 1 AND 40),
  unit_credit_micros bigint NOT NULL CHECK (unit_credit_micros > 0),
  total_credit_micros bigint NOT NULL CHECK (total_credit_micros > 0),
  listing_snapshot jsonb NOT NULL,
  reservation_expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (buyer_subject_id, client_request_id),
  CHECK (buyer_subject_id <> supplier_subject_id),
  CHECK (total_credit_micros = CEIL(quantity * unit_credit_micros)::bigint),
  CHECK ((status IN (
    'reserved', 'confirmed', 'provisioning', 'ready', 'in_service', 'acceptance_pending',
    'release_pending', 'refund_pending', 'disputed'
  )) = (closed_at IS NULL))
);
CREATE INDEX kai_credit_orders_buyer_created ON kai_credit_orders(buyer_subject_id, created_at DESC);
CREATE INDEX kai_credit_orders_supplier_created ON kai_credit_orders(supplier_subject_id, created_at DESC);
CREATE INDEX kai_credit_orders_reservation_expiry ON kai_credit_orders(reservation_expires_at, created_at)
  WHERE status = 'reserved';

ALTER TABLE kai_credit_order_requests ADD CONSTRAINT kai_credit_order_requests_order
  FOREIGN KEY (order_id) REFERENCES kai_credit_orders(id);

CREATE TABLE kai_credit_order_reservations (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES kai_credit_orders(id),
  listing_id uuid NOT NULL REFERENCES credit_market_listings(id),
  buyer_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  quantity numeric(24,6) NOT NULL CHECK (quantity > 0),
  credit_micros bigint NOT NULL CHECK (credit_micros > 0),
  reservation_transaction_id uuid NOT NULL UNIQUE REFERENCES kai_credit_transactions(id),
  resolution_transaction_id uuid UNIQUE REFERENCES kai_credit_transactions(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'released', 'captured')),
  expires_at timestamptz NOT NULL,
  resolved_at timestamptz,
  resolution_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'active') = (resolved_at IS NULL AND resolution_transaction_id IS NULL)),
  CHECK (status = 'active' OR resolution_reason IS NOT NULL)
);
CREATE INDEX kai_credit_order_reservations_expiry ON kai_credit_order_reservations(expires_at, created_at)
  WHERE status = 'active';

CREATE TABLE kai_credit_order_events (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES kai_credit_orders(id),
  actor_id uuid REFERENCES users(id),
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'operator', 'system', 'provider')),
  event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 3 AND 80),
  from_status text,
  to_status text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kai_credit_order_events_timeline ON kai_credit_order_events(order_id, created_at, id);

CREATE FUNCTION protect_kai_credit_order_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.order_number <> OLD.order_number
    OR NEW.buyer_subject_id <> OLD.buyer_subject_id OR NEW.supplier_subject_id <> OLD.supplier_subject_id
    OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.listing_id <> OLD.listing_id
    OR NEW.client_request_id <> OLD.client_request_id OR NEW.payload_digest <> OLD.payload_digest
    OR NEW.quantity <> OLD.quantity OR NEW.capacity_unit <> OLD.capacity_unit
    OR NEW.unit_credit_micros <> OLD.unit_credit_micros OR NEW.total_credit_micros <> OLD.total_credit_micros
    OR NEW.listing_snapshot <> OLD.listing_snapshot OR NEW.reservation_expires_at <> OLD.reservation_expires_at
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'kai credit order identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION protect_kai_credit_order_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'kai credit order reservations cannot be deleted'; END IF;
  IF NEW.id <> OLD.id OR NEW.order_id <> OLD.order_id OR NEW.listing_id <> OLD.listing_id
    OR NEW.buyer_subject_id <> OLD.buyer_subject_id OR NEW.quantity <> OLD.quantity
    OR NEW.credit_micros <> OLD.credit_micros OR NEW.reservation_transaction_id <> OLD.reservation_transaction_id
    OR NEW.expires_at <> OLD.expires_at OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'kai credit order reservation identity is immutable';
  END IF;
  IF OLD.status <> 'active' THEN RAISE EXCEPTION 'resolved kai credit order reservations are immutable'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER kai_credit_orders_identity_immutable
  BEFORE UPDATE ON kai_credit_orders FOR EACH ROW EXECUTE FUNCTION protect_kai_credit_order_identity();
CREATE TRIGGER kai_credit_orders_no_delete
  BEFORE DELETE ON kai_credit_orders FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER kai_credit_orders_updated_at
  BEFORE UPDATE ON kai_credit_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER kai_credit_order_reservations_guard
  BEFORE UPDATE OR DELETE ON kai_credit_order_reservations FOR EACH ROW EXECUTE FUNCTION protect_kai_credit_order_reservation();
CREATE TRIGGER kai_credit_order_events_immutable
  BEFORE UPDATE OR DELETE ON kai_credit_order_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER kai_credit_order_requests_updated_at
  BEFORE UPDATE ON kai_credit_order_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
