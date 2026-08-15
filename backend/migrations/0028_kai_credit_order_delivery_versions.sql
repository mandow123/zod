ALTER TABLE kai_credit_order_deliveries
  DROP CONSTRAINT kai_credit_order_deliveries_order_id_key,
  DROP CONSTRAINT kai_credit_order_deliveries_status_check,
  DROP CONSTRAINT kai_credit_order_deliveries_check,
  ADD COLUMN attempt_number integer,
  ADD CONSTRAINT kai_credit_order_delivery_attempts_status_check CHECK (
    status IN ('provisioning', 'ready', 'completed', 'superseded')
  ),
  ADD CONSTRAINT kai_credit_order_delivery_attempts_ready_state CHECK (
    (status IN ('ready', 'completed', 'superseded')) = (ready_at IS NOT NULL)
  );
UPDATE kai_credit_order_deliveries SET attempt_number = 1;
ALTER TABLE kai_credit_order_deliveries
  ALTER COLUMN attempt_number SET NOT NULL,
  ADD CONSTRAINT kai_credit_order_delivery_attempts_number_positive CHECK (attempt_number > 0),
  ADD CONSTRAINT kai_credit_order_delivery_attempts_id_order_unique UNIQUE (id, order_id),
  ADD CONSTRAINT kai_credit_order_delivery_attempts_order_number_unique UNIQUE (order_id, attempt_number);

ALTER TABLE kai_credit_order_acceptances ADD COLUMN delivery_attempt_id uuid;
UPDATE kai_credit_order_acceptances a SET delivery_attempt_id = d.id
  FROM kai_credit_order_deliveries d WHERE d.order_id = a.order_id;
ALTER TABLE kai_credit_order_acceptances
  ALTER COLUMN delivery_attempt_id SET NOT NULL,
  ADD CONSTRAINT kai_credit_order_acceptances_delivery_attempt_unique UNIQUE (delivery_attempt_id),
  ADD CONSTRAINT kai_credit_order_acceptances_delivery_attempt_order_fk FOREIGN KEY (delivery_attempt_id, order_id)
    REFERENCES kai_credit_order_deliveries(id, order_id);

ALTER TABLE kai_credit_order_delivery_issues
  DROP CONSTRAINT kai_credit_order_delivery_issues_order_id_key,
  DROP CONSTRAINT kai_credit_order_delivery_issues_status_check,
  ADD COLUMN delivery_attempt_id uuid,
  ADD COLUMN resolved_at timestamptz,
  ADD CONSTRAINT kai_credit_order_delivery_issues_status_check CHECK (
    status IN ('open', 'rework_started', 'reworked')
  );
UPDATE kai_credit_order_delivery_issues i SET delivery_attempt_id = d.id
  FROM kai_credit_order_deliveries d WHERE d.order_id = i.order_id;
ALTER TABLE kai_credit_order_delivery_issues
  ALTER COLUMN delivery_attempt_id SET NOT NULL,
  ADD CONSTRAINT kai_credit_order_delivery_issues_attempt_unique UNIQUE (delivery_attempt_id),
  ADD CONSTRAINT kai_credit_order_delivery_issues_attempt_order_fk FOREIGN KEY (delivery_attempt_id, order_id)
    REFERENCES kai_credit_order_deliveries(id, order_id),
  ADD CONSTRAINT kai_credit_order_delivery_issues_resolution_check CHECK (
    (status = 'reworked') = (resolved_at IS NOT NULL)
  );

ALTER TABLE kai_credit_order_action_requests
  DROP CONSTRAINT kai_credit_order_action_requests_action_check,
  DROP CONSTRAINT kai_credit_order_action_requests_result_check,
  ADD CONSTRAINT kai_credit_order_action_requests_action_check CHECK (
    action IN ('confirm', 'cancel', 'start_delivery', 'delivery_ready', 'accept',
      'report_delivery_issue', 'start_rework')
  ),
  ADD CONSTRAINT kai_credit_order_action_requests_result_check CHECK (
    result IN ('confirmed', 'cancelled', 'expired', 'provisioning', 'acceptance_pending', 'accepted',
      'disputed', 'invalid_state')
  );

DROP TRIGGER kai_credit_order_deliveries_guard ON kai_credit_order_deliveries;
DROP TRIGGER kai_credit_order_deliveries_updated_at ON kai_credit_order_deliveries;
DROP FUNCTION protect_kai_credit_order_delivery();
DROP TRIGGER kai_credit_order_delivery_issues_immutable ON kai_credit_order_delivery_issues;

CREATE FUNCTION protect_kai_credit_order_delivery_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'kai credit order delivery attempts cannot be deleted'; END IF;
  IF NEW.id <> OLD.id OR NEW.order_id <> OLD.order_id OR NEW.supplier_subject_id <> OLD.supplier_subject_id
    OR NEW.attempt_number <> OLD.attempt_number OR NEW.started_by_user_id <> OLD.started_by_user_id
    OR NEW.started_at <> OLD.started_at OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'kai credit order delivery attempt identity is immutable';
  END IF;
  IF OLD.status = 'provisioning' AND NEW.status <> 'ready' THEN
    RAISE EXCEPTION 'invalid provisioning delivery attempt transition';
  END IF;
  IF OLD.status = 'ready' AND (
    NEW.status NOT IN ('completed', 'superseded') OR NEW.ready_by_user_id IS DISTINCT FROM OLD.ready_by_user_id
    OR NEW.ready_at IS DISTINCT FROM OLD.ready_at
    OR NEW.delivery_payload_ciphertext IS DISTINCT FROM OLD.delivery_payload_ciphertext
    OR NEW.delivery_payload_digest IS DISTINCT FROM OLD.delivery_payload_digest
  ) THEN RAISE EXCEPTION 'ready delivery attempt payload is immutable'; END IF;
  IF OLD.status IN ('completed', 'superseded') THEN
    RAISE EXCEPTION 'resolved kai credit order delivery attempt is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION protect_kai_credit_order_delivery_issue() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'kai credit order delivery issues cannot be deleted'; END IF;
  IF NEW.id <> OLD.id OR NEW.order_id <> OLD.order_id OR NEW.delivery_attempt_id <> OLD.delivery_attempt_id
    OR NEW.buyer_subject_id <> OLD.buyer_subject_id OR NEW.opened_by_user_id <> OLD.opened_by_user_id
    OR NEW.requested_resolution <> OLD.requested_resolution
    OR NEW.description_ciphertext <> OLD.description_ciphertext OR NEW.description_digest <> OLD.description_digest
    OR NEW.request_payload_digest <> OLD.request_payload_digest OR NEW.opened_at <> OLD.opened_at
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'kai credit order delivery issue identity is immutable';
  END IF;
  IF OLD.status = 'open' AND NEW.status <> 'rework_started' THEN
    RAISE EXCEPTION 'invalid open delivery issue transition';
  END IF;
  IF OLD.status = 'rework_started' AND NEW.status <> 'reworked' THEN
    RAISE EXCEPTION 'invalid delivery rework transition';
  END IF;
  IF OLD.status = 'reworked' THEN RAISE EXCEPTION 'resolved delivery issue is immutable'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER kai_credit_order_delivery_attempts_guard
  BEFORE UPDATE OR DELETE ON kai_credit_order_deliveries
  FOR EACH ROW EXECUTE FUNCTION protect_kai_credit_order_delivery_attempt();
CREATE TRIGGER kai_credit_order_delivery_attempts_updated_at
  BEFORE UPDATE ON kai_credit_order_deliveries FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER kai_credit_order_delivery_issues_guard
  BEFORE UPDATE OR DELETE ON kai_credit_order_delivery_issues
  FOR EACH ROW EXECUTE FUNCTION protect_kai_credit_order_delivery_issue();

CREATE FUNCTION validate_kai_credit_order_acceptance_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE attempt_status text;
DECLARE reservation_status text;
DECLARE transaction_status text;
DECLARE transaction_scope text;
BEGIN
  SELECT status INTO attempt_status FROM kai_credit_order_deliveries
    WHERE id = NEW.delivery_attempt_id AND order_id = NEW.order_id;
  SELECT status INTO reservation_status FROM kai_credit_order_reservations WHERE order_id = NEW.order_id;
  SELECT status, scope INTO transaction_status, transaction_scope FROM kai_credit_transactions
    WHERE id = NEW.capture_transaction_id;
  IF attempt_status IS DISTINCT FROM 'completed' OR reservation_status IS DISTINCT FROM 'captured'
    OR transaction_status IS DISTINCT FROM 'posted' OR transaction_scope IS DISTINCT FROM 'CREDIT_ORDER_CAPTURE' THEN
    RAISE EXCEPTION 'invalid kai credit order acceptance attempt';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_kai_credit_order_delivery_issue_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE attempt_status text;
DECLARE reservation_status text;
BEGIN
  SELECT status INTO attempt_status FROM kai_credit_order_deliveries
    WHERE id = NEW.delivery_attempt_id AND order_id = NEW.order_id;
  SELECT status INTO reservation_status FROM kai_credit_order_reservations WHERE order_id = NEW.order_id;
  IF attempt_status IS DISTINCT FROM 'ready' OR reservation_status IS DISTINCT FROM 'secured' THEN
    RAISE EXCEPTION 'invalid kai credit order delivery issue attempt';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER kai_credit_order_acceptances_validate_attempt
  BEFORE INSERT ON kai_credit_order_acceptances
  FOR EACH ROW EXECUTE FUNCTION validate_kai_credit_order_acceptance_attempt();
CREATE TRIGGER kai_credit_order_delivery_issues_validate_attempt
  BEFORE INSERT ON kai_credit_order_delivery_issues
  FOR EACH ROW EXECUTE FUNCTION validate_kai_credit_order_delivery_issue_attempt();

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
    OR (OLD.status = 'disputed' AND NEW.status = 'provisioning')
  ) THEN RAISE EXCEPTION 'invalid kai credit order transition'; END IF;
  IF OLD.confirmed_at IS NOT NULL AND (
    NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at OR NEW.confirmed_by_user_id IS DISTINCT FROM OLD.confirmed_by_user_id
  ) THEN RAISE EXCEPTION 'kai credit order confirmation is immutable'; END IF;
  IF OLD.accepted_at IS NOT NULL AND (
    NEW.accepted_at IS DISTINCT FROM OLD.accepted_at OR NEW.accepted_by_user_id IS DISTINCT FROM OLD.accepted_by_user_id
  ) THEN RAISE EXCEPTION 'kai credit order acceptance is immutable'; END IF;
  IF OLD.closed_at IS NOT NULL AND NEW.closed_at IS DISTINCT FROM OLD.closed_at THEN
    RAISE EXCEPTION 'kai credit order closure is immutable';
  END IF;
  RETURN NEW;
END;
$$;
