ALTER TABLE kai_credit_order_delivery_issues
  DROP CONSTRAINT kai_credit_order_delivery_issues_status_check,
  DROP CONSTRAINT kai_credit_order_delivery_issues_resolution_check,
  ADD CONSTRAINT kai_credit_order_delivery_issues_status_check CHECK (
    status IN ('open', 'rework_started', 'reworked', 'escalated', 'dismissed', 'refunded')
  ),
  ADD CONSTRAINT kai_credit_order_delivery_issues_resolution_check CHECK (
    (status IN ('reworked', 'dismissed', 'refunded')) = (resolved_at IS NOT NULL)
  );

CREATE TABLE kai_credit_order_dispute_escalations (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES kai_credit_orders(id),
  delivery_issue_id uuid NOT NULL UNIQUE REFERENCES kai_credit_order_delivery_issues(id),
  buyer_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  supplier_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  escalated_by_user_id uuid NOT NULL REFERENCES users(id),
  escalated_by_side text NOT NULL CHECK (escalated_by_side IN ('buyer', 'provider')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
  escalated_at timestamptz NOT NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'pending') = (resolved_at IS NULL)),
  FOREIGN KEY (order_id, buyer_subject_id) REFERENCES kai_credit_orders(id, buyer_subject_id),
  FOREIGN KEY (order_id, supplier_subject_id) REFERENCES kai_credit_orders(id, supplier_subject_id)
);
CREATE INDEX kai_credit_order_dispute_escalations_queue
  ON kai_credit_order_dispute_escalations(escalated_at, id) WHERE status = 'pending';

CREATE TABLE kai_credit_order_dispute_decisions (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES kai_credit_orders(id),
  escalation_id uuid NOT NULL UNIQUE REFERENCES kai_credit_order_dispute_escalations(id),
  delivery_issue_id uuid NOT NULL UNIQUE REFERENCES kai_credit_order_delivery_issues(id),
  operator_id uuid NOT NULL REFERENCES users(id),
  outcome text NOT NULL CHECK (outcome IN ('full_refund', 'resume_acceptance')),
  reason_ciphertext text NOT NULL CHECK (char_length(reason_ciphertext) BETWEEN 16 AND 12000),
  reason_digest text NOT NULL CHECK (char_length(reason_digest) BETWEEN 16 AND 160),
  decision_digest text NOT NULL CHECK (char_length(decision_digest) BETWEEN 16 AND 160),
  credit_micros bigint NOT NULL CHECK (credit_micros >= 0),
  refund_transaction_id uuid UNIQUE REFERENCES kai_credit_transactions(id),
  decided_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (outcome = 'full_refund' AND credit_micros > 0 AND refund_transaction_id IS NOT NULL)
    OR (outcome = 'resume_acceptance' AND credit_micros = 0 AND refund_transaction_id IS NULL)
  )
);

CREATE TABLE kai_credit_order_dispute_decision_requests (
  operator_id uuid NOT NULL REFERENCES users(id),
  client_request_id text NOT NULL CHECK (char_length(client_request_id) BETWEEN 16 AND 120),
  order_id uuid NOT NULL REFERENCES kai_credit_orders(id),
  payload_digest text NOT NULL CHECK (char_length(payload_digest) BETWEEN 16 AND 160),
  decision_id uuid NOT NULL REFERENCES kai_credit_order_dispute_decisions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operator_id, client_request_id),
  UNIQUE (decision_id)
);

ALTER TABLE kai_credit_order_action_requests
  DROP CONSTRAINT kai_credit_order_action_requests_action_check,
  DROP CONSTRAINT kai_credit_order_action_requests_result_check,
  ADD CONSTRAINT kai_credit_order_action_requests_action_check CHECK (
    action IN ('confirm', 'cancel', 'start_delivery', 'delivery_ready', 'accept',
      'report_delivery_issue', 'start_rework', 'approve_refund', 'settle', 'escalate_dispute')
  ),
  ADD CONSTRAINT kai_credit_order_action_requests_result_check CHECK (
    result IN ('confirmed', 'cancelled', 'expired', 'provisioning', 'acceptance_pending', 'accepted',
      'disputed', 'refunded', 'settled', 'escalated', 'invalid_state')
  );

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
  IF OLD.status = 'open' AND NEW.status NOT IN ('rework_started', 'refunded', 'escalated') THEN
    RAISE EXCEPTION 'invalid open delivery issue transition';
  END IF;
  IF OLD.status = 'rework_started' AND NEW.status <> 'reworked' THEN
    RAISE EXCEPTION 'invalid delivery rework transition';
  END IF;
  IF OLD.status = 'escalated' AND NEW.status NOT IN ('dismissed', 'refunded') THEN
    RAISE EXCEPTION 'invalid escalated delivery issue transition';
  END IF;
  IF OLD.status IN ('reworked', 'dismissed', 'refunded') THEN
    RAISE EXCEPTION 'resolved delivery issue is immutable';
  END IF;
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
    OR (OLD.status = 'disputed' AND NEW.status IN ('provisioning', 'refunded', 'acceptance_pending'))
    OR (OLD.status = 'accepted' AND NEW.status = 'closed')
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

CREATE FUNCTION protect_kai_credit_order_dispute_escalation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'kai credit order dispute escalations cannot be deleted'; END IF;
  IF NEW.id <> OLD.id OR NEW.order_id <> OLD.order_id OR NEW.delivery_issue_id <> OLD.delivery_issue_id
    OR NEW.buyer_subject_id <> OLD.buyer_subject_id OR NEW.supplier_subject_id <> OLD.supplier_subject_id
    OR NEW.escalated_by_user_id <> OLD.escalated_by_user_id OR NEW.escalated_by_side <> OLD.escalated_by_side
    OR NEW.escalated_at <> OLD.escalated_at OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'kai credit order dispute escalation identity is immutable';
  END IF;
  IF OLD.status <> 'pending' OR NEW.status <> 'resolved' OR NEW.resolved_at IS NULL THEN
    RAISE EXCEPTION 'invalid kai credit order dispute escalation transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_kai_credit_order_dispute_escalation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_status text;
DECLARE order_buyer uuid;
DECLARE order_supplier uuid;
DECLARE issue_status text;
DECLARE issue_resolution text;
DECLARE issue_order uuid;
DECLARE reservation_status text;
DECLARE delivery_status text;
DECLARE member_valid boolean;
BEGIN
  SELECT status, buyer_subject_id, supplier_subject_id
    INTO order_status, order_buyer, order_supplier FROM kai_credit_orders WHERE id = NEW.order_id;
  SELECT status, requested_resolution, order_id INTO issue_status, issue_resolution, issue_order
    FROM kai_credit_order_delivery_issues WHERE id = NEW.delivery_issue_id;
  SELECT status INTO reservation_status FROM kai_credit_order_reservations WHERE order_id = NEW.order_id;
  SELECT status INTO delivery_status FROM kai_credit_order_deliveries
    WHERE id = (SELECT delivery_attempt_id FROM kai_credit_order_delivery_issues WHERE id = NEW.delivery_issue_id);
  SELECT EXISTS(SELECT 1 FROM subject_memberships m
      WHERE m.subject_id = CASE WHEN NEW.escalated_by_side = 'buyer' THEN NEW.buyer_subject_id ELSE NEW.supplier_subject_id END
        AND m.user_id = NEW.escalated_by_user_id AND m.status = 'active') INTO member_valid;
  IF order_status IS DISTINCT FROM 'disputed' OR order_buyer IS DISTINCT FROM NEW.buyer_subject_id
    OR order_supplier IS DISTINCT FROM NEW.supplier_subject_id OR issue_order IS DISTINCT FROM NEW.order_id
    OR issue_status IS DISTINCT FROM 'escalated' OR issue_resolution IS DISTINCT FROM 'refund'
    OR reservation_status IS DISTINCT FROM 'secured' OR delivery_status IS DISTINCT FROM 'ready'
    OR member_valid IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'invalid kai credit order dispute escalation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_kai_credit_order_dispute_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_total bigint;
DECLARE order_status text;
DECLARE issue_status text;
DECLARE issue_resolution text;
DECLARE escalation_status text;
DECLARE escalation_order uuid;
DECLARE reservation_status text;
DECLARE delivery_status text;
DECLARE transaction_status text;
DECLARE transaction_scope text;
DECLARE order_buyer uuid;
DECLARE operator_valid boolean;
DECLARE entry_count integer;
DECLARE available_amount bigint;
DECLARE reserved_amount bigint;
BEGIN
  SELECT total_credit_micros, status, buyer_subject_id INTO order_total, order_status, order_buyer
    FROM kai_credit_orders WHERE id = NEW.order_id;
  SELECT status, requested_resolution INTO issue_status, issue_resolution
    FROM kai_credit_order_delivery_issues WHERE id = NEW.delivery_issue_id AND order_id = NEW.order_id;
  SELECT status, order_id INTO escalation_status, escalation_order
    FROM kai_credit_order_dispute_escalations WHERE id = NEW.escalation_id;
  SELECT status INTO reservation_status FROM kai_credit_order_reservations WHERE order_id = NEW.order_id;
  SELECT status INTO delivery_status FROM kai_credit_order_deliveries
    WHERE id = (SELECT delivery_attempt_id FROM kai_credit_order_delivery_issues WHERE id = NEW.delivery_issue_id);
  IF NEW.refund_transaction_id IS NOT NULL THEN
    SELECT status, scope INTO transaction_status, transaction_scope
      FROM kai_credit_transactions WHERE id = NEW.refund_transaction_id;
    SELECT count(*),
        COALESCE(sum(CASE WHEN a.subject_id = order_buyer AND a.account_kind = 'available'
          THEN e.amount_micros ELSE 0 END), 0),
        COALESCE(sum(CASE WHEN a.subject_id = order_buyer AND a.account_kind = 'reserved'
          THEN e.amount_micros ELSE 0 END), 0)
      INTO entry_count, available_amount, reserved_amount
      FROM kai_credit_entries e JOIN kai_credit_accounts a ON a.id = e.account_id
      WHERE e.transaction_id = NEW.refund_transaction_id;
  END IF;
  SELECT EXISTS(SELECT 1 FROM users u WHERE u.id = NEW.operator_id
      AND u.role IN ('operator', 'admin') AND u.status = 'active') INTO operator_valid;
  IF issue_resolution IS DISTINCT FROM 'refund' OR escalation_status IS DISTINCT FROM 'resolved'
    OR escalation_order IS DISTINCT FROM NEW.order_id OR operator_valid IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'invalid kai credit order dispute decision';
  END IF;
  IF NEW.outcome = 'full_refund' AND (
    NEW.credit_micros <> order_total OR order_status IS DISTINCT FROM 'refunded'
    OR issue_status IS DISTINCT FROM 'refunded' OR reservation_status IS DISTINCT FROM 'released'
    OR delivery_status IS DISTINCT FROM 'refunded' OR transaction_status IS DISTINCT FROM 'posted'
    OR transaction_scope IS DISTINCT FROM 'CREDIT_ORDER_ADJUDICATED_REFUND'
    OR entry_count <> 2 OR available_amount <> NEW.credit_micros OR reserved_amount <> -NEW.credit_micros
  ) THEN RAISE EXCEPTION 'invalid adjudicated full refund'; END IF;
  IF NEW.outcome = 'resume_acceptance' AND (
    NEW.credit_micros <> 0 OR order_status IS DISTINCT FROM 'acceptance_pending'
    OR issue_status IS DISTINCT FROM 'dismissed' OR reservation_status IS DISTINCT FROM 'secured'
    OR delivery_status IS DISTINCT FROM 'ready' OR NEW.refund_transaction_id IS NOT NULL
  ) THEN RAISE EXCEPTION 'invalid adjudicated acceptance resumption'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_kai_credit_order_dispute_decision_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE decision_order uuid;
DECLARE decision_operator uuid;
BEGIN
  SELECT order_id, operator_id INTO decision_order, decision_operator
    FROM kai_credit_order_dispute_decisions WHERE id = NEW.decision_id;
  IF decision_order IS DISTINCT FROM NEW.order_id OR decision_operator IS DISTINCT FROM NEW.operator_id THEN
    RAISE EXCEPTION 'invalid kai credit order dispute decision request';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER kai_credit_order_dispute_escalations_guard
  BEFORE UPDATE OR DELETE ON kai_credit_order_dispute_escalations
  FOR EACH ROW EXECUTE FUNCTION protect_kai_credit_order_dispute_escalation();
CREATE TRIGGER kai_credit_order_dispute_escalations_validate
  BEFORE INSERT ON kai_credit_order_dispute_escalations
  FOR EACH ROW EXECUTE FUNCTION validate_kai_credit_order_dispute_escalation();
CREATE TRIGGER kai_credit_order_dispute_decisions_validate
  BEFORE INSERT ON kai_credit_order_dispute_decisions
  FOR EACH ROW EXECUTE FUNCTION validate_kai_credit_order_dispute_decision();
CREATE TRIGGER kai_credit_order_dispute_decisions_immutable
  BEFORE UPDATE OR DELETE ON kai_credit_order_dispute_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER kai_credit_order_dispute_decision_requests_immutable
  BEFORE UPDATE OR DELETE ON kai_credit_order_dispute_decision_requests
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER kai_credit_order_dispute_decision_requests_validate
  BEFORE INSERT ON kai_credit_order_dispute_decision_requests
  FOR EACH ROW EXECUTE FUNCTION validate_kai_credit_order_dispute_decision_request();

CREATE FUNCTION require_kai_credit_refund_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'refunded'
    AND NOT EXISTS (SELECT 1 FROM kai_credit_order_mutual_refunds r WHERE r.order_id = NEW.id)
    AND NOT EXISTS (SELECT 1 FROM kai_credit_order_dispute_decisions d
      WHERE d.order_id = NEW.id AND d.outcome = 'full_refund') THEN
    RAISE EXCEPTION 'refunded kai credit order requires refund record';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER kai_credit_refunded_order_requires_record
  AFTER INSERT OR UPDATE OF status ON kai_credit_orders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_kai_credit_refund_record();

CREATE FUNCTION require_kai_credit_dispute_escalation_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'escalated' AND NOT EXISTS (
    SELECT 1 FROM kai_credit_order_dispute_escalations e WHERE e.delivery_issue_id = NEW.id
  ) THEN RAISE EXCEPTION 'escalated delivery issue requires escalation record'; END IF;
  IF NEW.status = 'dismissed' AND NOT EXISTS (
    SELECT 1 FROM kai_credit_order_dispute_decisions d
      WHERE d.delivery_issue_id = NEW.id AND d.outcome = 'resume_acceptance'
  ) THEN RAISE EXCEPTION 'dismissed delivery issue requires decision record'; END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION require_kai_credit_dispute_decision_for_resolution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'resolved' AND NOT EXISTS (
    SELECT 1 FROM kai_credit_order_dispute_decisions d WHERE d.escalation_id = NEW.id
  ) THEN RAISE EXCEPTION 'resolved dispute escalation requires decision record'; END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION require_kai_credit_resume_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'disputed' AND NEW.status = 'acceptance_pending' AND NOT EXISTS (
    SELECT 1 FROM kai_credit_order_dispute_decisions d
      WHERE d.order_id = NEW.id AND d.outcome = 'resume_acceptance'
  ) THEN RAISE EXCEPTION 'resumed acceptance requires dispute decision'; END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION require_kai_credit_active_issue_for_disputed_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'disputed' AND NOT EXISTS (
    SELECT 1 FROM kai_credit_order_delivery_issues i
      WHERE i.order_id = NEW.id AND i.status IN ('open', 'escalated')
  ) THEN RAISE EXCEPTION 'disputed kai credit order requires active delivery issue'; END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER kai_credit_delivery_issue_requires_adjudication_record
  AFTER INSERT OR UPDATE OF status ON kai_credit_order_delivery_issues
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_kai_credit_dispute_escalation_record();
CREATE CONSTRAINT TRIGGER kai_credit_dispute_resolution_requires_decision
  AFTER INSERT OR UPDATE OF status ON kai_credit_order_dispute_escalations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_kai_credit_dispute_decision_for_resolution();
CREATE CONSTRAINT TRIGGER kai_credit_acceptance_resumption_requires_decision
  AFTER UPDATE OF status ON kai_credit_orders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_kai_credit_resume_decision();
CREATE CONSTRAINT TRIGGER kai_credit_disputed_order_requires_active_issue
  AFTER INSERT OR UPDATE OF status ON kai_credit_orders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_kai_credit_active_issue_for_disputed_order();
