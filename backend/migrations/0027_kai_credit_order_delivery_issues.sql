CREATE TABLE kai_credit_order_delivery_issues (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES kai_credit_orders(id),
  buyer_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  opened_by_user_id uuid NOT NULL REFERENCES users(id),
  requested_resolution text NOT NULL CHECK (requested_resolution IN ('rework', 'refund')),
  description_ciphertext text NOT NULL CHECK (char_length(description_ciphertext) BETWEEN 16 AND 32768),
  description_digest text NOT NULL CHECK (char_length(description_digest) BETWEEN 16 AND 160),
  request_payload_digest text NOT NULL CHECK (char_length(request_payload_digest) BETWEEN 16 AND 160),
  status text NOT NULL DEFAULT 'open' CHECK (status = 'open'),
  opened_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (order_id, buyer_subject_id) REFERENCES kai_credit_orders(id, buyer_subject_id)
);
CREATE INDEX kai_credit_order_delivery_issues_buyer_time
  ON kai_credit_order_delivery_issues(buyer_subject_id, opened_at DESC);

ALTER TABLE kai_credit_order_action_requests
  DROP CONSTRAINT kai_credit_order_action_requests_action_check,
  DROP CONSTRAINT kai_credit_order_action_requests_result_check,
  ADD CONSTRAINT kai_credit_order_action_requests_action_check CHECK (
    action IN ('confirm', 'cancel', 'start_delivery', 'delivery_ready', 'accept', 'report_delivery_issue')
  ),
  ADD CONSTRAINT kai_credit_order_action_requests_result_check CHECK (
    result IN ('confirmed', 'cancelled', 'expired', 'provisioning', 'acceptance_pending', 'accepted', 'disputed', 'invalid_state')
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
    OR (OLD.status = 'acceptance_pending' AND NEW.status IN ('accepted', 'disputed'))
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

CREATE TRIGGER kai_credit_order_delivery_issues_immutable
  BEFORE UPDATE OR DELETE ON kai_credit_order_delivery_issues
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
