ALTER TABLE kai_credit_orders
  ADD COLUMN delivery_started_at timestamptz,
  ADD COLUMN delivery_ready_at timestamptz,
  ADD COLUMN accepted_at timestamptz,
  ADD COLUMN accepted_by_user_id uuid REFERENCES users(id),
  ADD CONSTRAINT kai_credit_orders_delivery_times CHECK (
    (delivery_ready_at IS NULL OR delivery_started_at IS NOT NULL)
    AND (accepted_at IS NULL OR delivery_ready_at IS NOT NULL)
    AND ((accepted_at IS NULL) = (accepted_by_user_id IS NULL))
  ),
  ADD CONSTRAINT kai_credit_orders_id_supplier_unique UNIQUE (id, supplier_subject_id),
  ADD CONSTRAINT kai_credit_orders_id_buyer_unique UNIQUE (id, buyer_subject_id);

CREATE TABLE kai_credit_order_deliveries (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES kai_credit_orders(id),
  supplier_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  started_by_user_id uuid NOT NULL REFERENCES users(id),
  started_at timestamptz NOT NULL,
  ready_by_user_id uuid REFERENCES users(id),
  ready_at timestamptz,
  status text NOT NULL CHECK (status IN ('provisioning', 'ready', 'completed')),
  delivery_payload_ciphertext text,
  delivery_payload_digest text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('ready', 'completed')) = (ready_at IS NOT NULL)),
  CHECK ((delivery_payload_ciphertext IS NULL) = (delivery_payload_digest IS NULL)),
  CHECK (status = 'provisioning' OR (ready_by_user_id IS NOT NULL AND delivery_payload_ciphertext IS NOT NULL)),
  FOREIGN KEY (order_id, supplier_subject_id) REFERENCES kai_credit_orders(id, supplier_subject_id)
);

CREATE TABLE kai_credit_order_acceptances (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES kai_credit_orders(id),
  buyer_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  accepted_by_user_id uuid NOT NULL REFERENCES users(id),
  result text NOT NULL CHECK (result IN ('accepted')),
  evidence_digest text,
  capture_transaction_id uuid NOT NULL UNIQUE REFERENCES kai_credit_transactions(id),
  accepted_at timestamptz NOT NULL,
  FOREIGN KEY (order_id, buyer_subject_id) REFERENCES kai_credit_orders(id, buyer_subject_id)
);

ALTER TABLE kai_credit_order_action_requests
  DROP CONSTRAINT kai_credit_order_action_requests_action_check,
  DROP CONSTRAINT kai_credit_order_action_requests_result_check,
  ADD CONSTRAINT kai_credit_order_action_requests_action_check CHECK (
    action IN ('confirm', 'cancel', 'start_delivery', 'delivery_ready', 'accept')
  ),
  ADD CONSTRAINT kai_credit_order_action_requests_result_check CHECK (
    result IN ('confirmed', 'cancelled', 'expired', 'provisioning', 'acceptance_pending', 'accepted', 'invalid_state')
  );

CREATE OR REPLACE FUNCTION protect_kai_credit_order_identity() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'reserved' AND NEW.status IN ('confirmed', 'cancelled', 'expired'))
    OR (OLD.status = 'confirmed' AND NEW.status = 'provisioning')
    OR (OLD.status = 'provisioning' AND NEW.status = 'acceptance_pending')
    OR (OLD.status = 'acceptance_pending' AND NEW.status = 'accepted')
  ) THEN RAISE EXCEPTION 'invalid kai credit order transition'; END IF;
  IF OLD.confirmed_at IS NOT NULL AND (
    NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at OR NEW.confirmed_by_user_id IS DISTINCT FROM OLD.confirmed_by_user_id
  ) THEN RAISE EXCEPTION 'kai credit order confirmation is immutable'; END IF;
  IF OLD.delivery_started_at IS NOT NULL AND NEW.delivery_started_at IS DISTINCT FROM OLD.delivery_started_at THEN
    RAISE EXCEPTION 'kai credit order delivery start is immutable';
  END IF;
  IF OLD.delivery_ready_at IS NOT NULL AND NEW.delivery_ready_at IS DISTINCT FROM OLD.delivery_ready_at THEN
    RAISE EXCEPTION 'kai credit order delivery readiness is immutable';
  END IF;
  IF OLD.accepted_at IS NOT NULL AND (
    NEW.accepted_at IS DISTINCT FROM OLD.accepted_at OR NEW.accepted_by_user_id IS DISTINCT FROM OLD.accepted_by_user_id
  ) THEN RAISE EXCEPTION 'kai credit order acceptance is immutable'; END IF;
  IF OLD.closed_at IS NOT NULL AND NEW.closed_at IS DISTINCT FROM OLD.closed_at THEN
    RAISE EXCEPTION 'kai credit order closure is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION protect_kai_credit_order_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'kai credit order deliveries cannot be deleted'; END IF;
  IF NEW.id <> OLD.id OR NEW.order_id <> OLD.order_id OR NEW.supplier_subject_id <> OLD.supplier_subject_id
    OR NEW.started_by_user_id <> OLD.started_by_user_id OR NEW.started_at <> OLD.started_at
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'kai credit order delivery identity is immutable';
  END IF;
  IF OLD.status = 'provisioning' AND NEW.status <> 'ready' THEN
    RAISE EXCEPTION 'invalid provisioning delivery transition';
  END IF;
  IF OLD.status = 'ready' AND (
    NEW.status <> 'completed' OR NEW.ready_by_user_id IS DISTINCT FROM OLD.ready_by_user_id
    OR NEW.ready_at IS DISTINCT FROM OLD.ready_at
    OR NEW.delivery_payload_ciphertext IS DISTINCT FROM OLD.delivery_payload_ciphertext
    OR NEW.delivery_payload_digest IS DISTINCT FROM OLD.delivery_payload_digest
  ) THEN RAISE EXCEPTION 'ready delivery payload is immutable'; END IF;
  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION 'resolved kai credit order delivery is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER kai_credit_order_deliveries_guard
  BEFORE UPDATE OR DELETE ON kai_credit_order_deliveries FOR EACH ROW EXECUTE FUNCTION protect_kai_credit_order_delivery();
CREATE TRIGGER kai_credit_order_deliveries_updated_at
  BEFORE UPDATE ON kai_credit_order_deliveries FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER kai_credit_order_acceptances_immutable
  BEFORE UPDATE OR DELETE ON kai_credit_order_acceptances FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
