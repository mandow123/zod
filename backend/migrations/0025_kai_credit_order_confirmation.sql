ALTER TABLE kai_credit_orders
  ADD COLUMN confirmed_at timestamptz,
  ADD COLUMN confirmed_by_user_id uuid REFERENCES users(id),
  ADD CONSTRAINT kai_credit_orders_confirmation_pair CHECK ((confirmed_at IS NULL) = (confirmed_by_user_id IS NULL)),
  ADD CONSTRAINT kai_credit_orders_confirmation_state CHECK (
    (status = 'reserved' AND confirmed_at IS NULL)
    OR status IN ('cancelled', 'expired')
    OR (status NOT IN ('reserved', 'cancelled', 'expired') AND confirmed_at IS NOT NULL)
  );

ALTER TABLE kai_credit_order_reservations
  DROP CONSTRAINT kai_credit_order_reservations_status_check,
  DROP CONSTRAINT kai_credit_order_reservations_check,
  DROP CONSTRAINT kai_credit_order_reservations_check1,
  ADD COLUMN secured_at timestamptz,
  ADD COLUMN secured_by_user_id uuid REFERENCES users(id),
  ADD CONSTRAINT kai_credit_order_reservations_status_check CHECK (
    status IN ('active', 'secured', 'expired', 'released', 'captured')
  ),
  ADD CONSTRAINT kai_credit_order_reservations_resolution_check CHECK (
    (status IN ('active', 'secured')) = (resolved_at IS NULL AND resolution_transaction_id IS NULL)
  ),
  ADD CONSTRAINT kai_credit_order_reservations_resolution_reason_check CHECK (
    status IN ('active', 'secured') OR resolution_reason IS NOT NULL
  ),
  ADD CONSTRAINT kai_credit_order_reservations_security_pair CHECK (
    (secured_at IS NULL) = (secured_by_user_id IS NULL)
  ),
  ADD CONSTRAINT kai_credit_order_reservations_security_state CHECK (
    status <> 'secured' OR secured_at IS NOT NULL
  );

CREATE TABLE kai_credit_order_action_requests (
  subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  action text NOT NULL CHECK (action IN ('confirm', 'cancel')),
  client_request_id text NOT NULL CHECK (char_length(client_request_id) BETWEEN 16 AND 120),
  order_id uuid NOT NULL REFERENCES kai_credit_orders(id),
  payload_digest text NOT NULL CHECK (char_length(payload_digest) BETWEEN 16 AND 160),
  result text NOT NULL CHECK (result IN ('confirmed', 'cancelled', 'expired', 'invalid_state')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_id, action, client_request_id)
);

CREATE OR REPLACE FUNCTION protect_kai_credit_order_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'kai credit order reservations cannot be deleted'; END IF;
  IF NEW.id <> OLD.id OR NEW.order_id <> OLD.order_id OR NEW.listing_id <> OLD.listing_id
    OR NEW.buyer_subject_id <> OLD.buyer_subject_id OR NEW.quantity <> OLD.quantity
    OR NEW.credit_micros <> OLD.credit_micros OR NEW.reservation_transaction_id <> OLD.reservation_transaction_id
    OR NEW.expires_at <> OLD.expires_at OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'kai credit order reservation identity is immutable';
  END IF;
  IF OLD.status = 'active' AND NEW.status NOT IN ('secured', 'expired', 'released') THEN
    RAISE EXCEPTION 'invalid active kai credit reservation transition';
  END IF;
  IF OLD.status = 'secured' AND NEW.status NOT IN ('captured', 'released') THEN
    RAISE EXCEPTION 'invalid secured kai credit reservation transition';
  END IF;
  IF OLD.status NOT IN ('active', 'secured') THEN
    RAISE EXCEPTION 'resolved kai credit order reservations are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER kai_credit_order_action_requests_immutable
  BEFORE UPDATE OR DELETE ON kai_credit_order_action_requests
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
