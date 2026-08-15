ALTER TABLE kai_credit_order_deliveries
  DROP CONSTRAINT kai_credit_order_delivery_attempts_status_check,
  DROP CONSTRAINT kai_credit_order_delivery_attempts_ready_state,
  ADD CONSTRAINT kai_credit_order_delivery_attempts_status_check CHECK (
    status IN ('provisioning', 'ready', 'completed', 'superseded', 'refunded')
  ),
  ADD CONSTRAINT kai_credit_order_delivery_attempts_ready_state CHECK (
    (status IN ('ready', 'completed', 'superseded', 'refunded')) = (ready_at IS NOT NULL)
  );

ALTER TABLE kai_credit_order_delivery_issues
  DROP CONSTRAINT kai_credit_order_delivery_issues_status_check,
  DROP CONSTRAINT kai_credit_order_delivery_issues_resolution_check,
  ADD CONSTRAINT kai_credit_order_delivery_issues_status_check CHECK (
    status IN ('open', 'rework_started', 'reworked', 'refunded')
  ),
  ADD CONSTRAINT kai_credit_order_delivery_issues_resolution_check CHECK (
    (status IN ('reworked', 'refunded')) = (resolved_at IS NOT NULL)
  );

CREATE TABLE kai_credit_order_mutual_refunds (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES kai_credit_orders(id),
  delivery_issue_id uuid NOT NULL UNIQUE REFERENCES kai_credit_order_delivery_issues(id),
  buyer_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  supplier_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  approved_by_user_id uuid NOT NULL REFERENCES users(id),
  credit_micros bigint NOT NULL CHECK (credit_micros > 0),
  refund_transaction_id uuid NOT NULL UNIQUE REFERENCES kai_credit_transactions(id),
  status text NOT NULL CHECK (status = 'succeeded'),
  approved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (order_id, buyer_subject_id) REFERENCES kai_credit_orders(id, buyer_subject_id),
  FOREIGN KEY (order_id, supplier_subject_id) REFERENCES kai_credit_orders(id, supplier_subject_id)
);

ALTER TABLE kai_credit_order_action_requests
  DROP CONSTRAINT kai_credit_order_action_requests_action_check,
  DROP CONSTRAINT kai_credit_order_action_requests_result_check,
  ADD CONSTRAINT kai_credit_order_action_requests_action_check CHECK (
    action IN ('confirm', 'cancel', 'start_delivery', 'delivery_ready', 'accept',
      'report_delivery_issue', 'start_rework', 'approve_refund')
  ),
  ADD CONSTRAINT kai_credit_order_action_requests_result_check CHECK (
    result IN ('confirmed', 'cancelled', 'expired', 'provisioning', 'acceptance_pending', 'accepted',
      'disputed', 'refunded', 'invalid_state')
  );

CREATE OR REPLACE FUNCTION protect_kai_credit_order_delivery_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
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
    NEW.status NOT IN ('completed', 'superseded', 'refunded')
    OR NEW.ready_by_user_id IS DISTINCT FROM OLD.ready_by_user_id
    OR NEW.ready_at IS DISTINCT FROM OLD.ready_at
    OR NEW.delivery_payload_ciphertext IS DISTINCT FROM OLD.delivery_payload_ciphertext
    OR NEW.delivery_payload_digest IS DISTINCT FROM OLD.delivery_payload_digest
  ) THEN RAISE EXCEPTION 'ready delivery attempt payload is immutable'; END IF;
  IF OLD.status IN ('completed', 'superseded', 'refunded') THEN
    RAISE EXCEPTION 'resolved kai credit order delivery attempt is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION protect_kai_credit_order_delivery_issue() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF OLD.status = 'open' AND NEW.status NOT IN ('rework_started', 'refunded') THEN
    RAISE EXCEPTION 'invalid open delivery issue transition';
  END IF;
  IF OLD.status = 'rework_started' AND NEW.status <> 'reworked' THEN
    RAISE EXCEPTION 'invalid delivery rework transition';
  END IF;
  IF OLD.status IN ('reworked', 'refunded') THEN RAISE EXCEPTION 'resolved delivery issue is immutable'; END IF;
  RETURN NEW;
END;
$$;

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
    OR (OLD.status = 'disputed' AND NEW.status IN ('provisioning', 'refunded'))
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

CREATE FUNCTION validate_kai_credit_order_mutual_refund() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_total bigint;
DECLARE order_status text;
DECLARE issue_status text;
DECLARE requested_resolution text;
DECLARE reservation_status text;
DECLARE transaction_status text;
DECLARE transaction_scope text;
BEGIN
  SELECT total_credit_micros, status INTO order_total, order_status
    FROM kai_credit_orders WHERE id = NEW.order_id;
  SELECT status, i.requested_resolution INTO issue_status, requested_resolution
    FROM kai_credit_order_delivery_issues i WHERE id = NEW.delivery_issue_id AND i.order_id = NEW.order_id;
  SELECT status INTO reservation_status FROM kai_credit_order_reservations WHERE order_id = NEW.order_id;
  SELECT status, scope INTO transaction_status, transaction_scope FROM kai_credit_transactions
    WHERE id = NEW.refund_transaction_id;
  IF NEW.credit_micros <> order_total OR order_status IS DISTINCT FROM 'refunded'
    OR issue_status IS DISTINCT FROM 'refunded' OR requested_resolution IS DISTINCT FROM 'refund'
    OR reservation_status IS DISTINCT FROM 'released' OR transaction_status IS DISTINCT FROM 'posted'
    OR transaction_scope IS DISTINCT FROM 'CREDIT_ORDER_MUTUAL_REFUND' THEN
    RAISE EXCEPTION 'invalid kai credit order mutual refund';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER kai_credit_order_mutual_refunds_validate
  BEFORE INSERT ON kai_credit_order_mutual_refunds
  FOR EACH ROW EXECUTE FUNCTION validate_kai_credit_order_mutual_refund();
CREATE TRIGGER kai_credit_order_mutual_refunds_immutable
  BEFORE UPDATE OR DELETE ON kai_credit_order_mutual_refunds
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
