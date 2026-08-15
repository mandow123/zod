ALTER TABLE kai_credit_order_post_acceptance_refunds
  DROP CONSTRAINT kai_credit_order_post_acceptance_refunds_status_check,
  DROP CONSTRAINT kai_credit_order_post_acceptance_refunds_check,
  ADD CONSTRAINT kai_credit_post_acceptance_refund_status_check CHECK (
    status IN ('pending', 'escalated', 'succeeded', 'rejected')
  ),
  ADD CONSTRAINT kai_credit_post_acceptance_refund_resolution_check CHECK (
    (status IN ('pending', 'escalated') AND approved_by_user_id IS NULL
      AND refund_transaction_id IS NULL AND resolved_at IS NULL)
    OR (status = 'succeeded' AND refund_transaction_id IS NOT NULL AND resolved_at IS NOT NULL)
    OR (status = 'rejected' AND approved_by_user_id IS NULL
      AND refund_transaction_id IS NULL AND resolved_at IS NOT NULL)
  );

CREATE TABLE kai_credit_post_acceptance_refund_escalations (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES kai_credit_orders(id),
  refund_id uuid NOT NULL UNIQUE REFERENCES kai_credit_order_post_acceptance_refunds(id),
  buyer_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  supplier_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  escalated_by_user_id uuid NOT NULL REFERENCES users(id),
  escalated_by_side text NOT NULL CHECK (escalated_by_side IN ('buyer', 'provider')),
  provider_response_ciphertext text,
  provider_response_digest text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
  escalated_at timestamptz NOT NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'pending') = (resolved_at IS NULL)),
  CHECK (
    (escalated_by_side = 'provider' AND provider_response_ciphertext IS NOT NULL
      AND char_length(provider_response_ciphertext) BETWEEN 16 AND 12000
      AND provider_response_digest IS NOT NULL AND char_length(provider_response_digest) BETWEEN 16 AND 160)
    OR (escalated_by_side = 'buyer' AND provider_response_ciphertext IS NULL
      AND provider_response_digest IS NULL)
  ),
  FOREIGN KEY (order_id, buyer_subject_id) REFERENCES kai_credit_orders(id, buyer_subject_id),
  FOREIGN KEY (order_id, supplier_subject_id) REFERENCES kai_credit_orders(id, supplier_subject_id)
);
CREATE INDEX kai_credit_post_acceptance_refund_escalations_queue
  ON kai_credit_post_acceptance_refund_escalations(escalated_at, id) WHERE status = 'pending';

CREATE TABLE kai_credit_post_acceptance_refund_decisions (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES kai_credit_orders(id),
  refund_id uuid NOT NULL UNIQUE REFERENCES kai_credit_order_post_acceptance_refunds(id),
  escalation_id uuid NOT NULL UNIQUE REFERENCES kai_credit_post_acceptance_refund_escalations(id),
  operator_id uuid NOT NULL REFERENCES users(id),
  outcome text NOT NULL CHECK (outcome IN ('full_refund', 'reject_refund')),
  reason_ciphertext text NOT NULL CHECK (char_length(reason_ciphertext) BETWEEN 16 AND 12000),
  reason_digest text NOT NULL CHECK (char_length(reason_digest) BETWEEN 16 AND 160),
  decision_digest text NOT NULL CHECK (char_length(decision_digest) BETWEEN 16 AND 160),
  credit_micros bigint NOT NULL CHECK (credit_micros >= 0),
  refund_transaction_id uuid UNIQUE REFERENCES kai_credit_transactions(id),
  decided_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (outcome = 'full_refund' AND credit_micros > 0 AND refund_transaction_id IS NOT NULL)
    OR (outcome = 'reject_refund' AND credit_micros = 0 AND refund_transaction_id IS NULL)
  )
);

CREATE TABLE kai_credit_post_acceptance_refund_decision_requests (
  operator_id uuid NOT NULL REFERENCES users(id),
  client_request_id text NOT NULL CHECK (char_length(client_request_id) BETWEEN 16 AND 120),
  order_id uuid NOT NULL REFERENCES kai_credit_orders(id),
  payload_digest text NOT NULL CHECK (char_length(payload_digest) BETWEEN 16 AND 160),
  decision_id uuid NOT NULL UNIQUE REFERENCES kai_credit_post_acceptance_refund_decisions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operator_id, client_request_id)
);

ALTER TABLE kai_credit_order_action_requests
  DROP CONSTRAINT kai_credit_order_action_requests_action_check,
  DROP CONSTRAINT kai_credit_order_action_requests_result_check,
  ADD CONSTRAINT kai_credit_order_action_requests_action_check CHECK (
    action IN ('confirm', 'cancel', 'start_delivery', 'delivery_ready', 'accept',
      'report_delivery_issue', 'start_rework', 'approve_refund', 'settle', 'escalate_dispute',
      'request_post_acceptance_refund', 'approve_post_acceptance_refund',
      'contest_post_acceptance_refund', 'escalate_post_acceptance_refund')
  ),
  ADD CONSTRAINT kai_credit_order_action_requests_result_check CHECK (
    result IN ('confirmed', 'cancelled', 'expired', 'provisioning', 'acceptance_pending', 'accepted',
      'disputed', 'refunded', 'settled', 'escalated', 'aftercare_pending', 'aftercare_escalated', 'invalid_state')
  );

CREATE OR REPLACE FUNCTION protect_kai_credit_post_acceptance_refund() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_status text;
DECLARE order_total bigint;
DECLARE reservation_status text;
DECLARE delivery_status text;
DECLARE transaction_status text;
DECLARE transaction_scope text;
DECLARE transaction_reference_type text;
DECLARE transaction_reference_id uuid;
DECLARE entry_count integer;
DECLARE buyer_available_amount bigint;
DECLARE supplier_receivable_amount bigint;
DECLARE provider_valid boolean;
DECLARE sold_quantity numeric(24,6);
DECLARE order_quantity numeric(24,6);
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'kai credit post acceptance refunds cannot be deleted'; END IF;
  IF NEW.id <> OLD.id OR NEW.order_id <> OLD.order_id OR NEW.acceptance_id <> OLD.acceptance_id
    OR NEW.buyer_subject_id <> OLD.buyer_subject_id OR NEW.supplier_subject_id <> OLD.supplier_subject_id
    OR NEW.requested_by_user_id <> OLD.requested_by_user_id
    OR NEW.description_ciphertext <> OLD.description_ciphertext OR NEW.description_digest <> OLD.description_digest
    OR NEW.credit_micros <> OLD.credit_micros OR NEW.requested_at <> OLD.requested_at
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'kai credit post acceptance refund identity is immutable';
  END IF;
  IF NOT (
    (OLD.status = 'pending' AND NEW.status IN ('succeeded', 'escalated'))
    OR (OLD.status = 'escalated' AND NEW.status IN ('succeeded', 'rejected'))
  ) THEN RAISE EXCEPTION 'invalid kai credit post acceptance refund transition'; END IF;
  SELECT status, total_credit_micros, quantity INTO order_status, order_total, order_quantity
    FROM kai_credit_orders WHERE id = NEW.order_id;
  SELECT status INTO reservation_status FROM kai_credit_order_reservations WHERE order_id = NEW.order_id;
  SELECT status INTO delivery_status FROM kai_credit_order_deliveries
    WHERE id = (SELECT delivery_attempt_id FROM kai_credit_order_acceptances WHERE id = NEW.acceptance_id);
  SELECT capacity_sold INTO sold_quantity FROM credit_market_listings
    WHERE id = (SELECT listing_id FROM kai_credit_orders WHERE id = NEW.order_id);
  IF NEW.refund_transaction_id IS NOT NULL THEN
    SELECT status, scope, reference_type, reference_id
      INTO transaction_status, transaction_scope, transaction_reference_type, transaction_reference_id
      FROM kai_credit_transactions WHERE id = NEW.refund_transaction_id;
    SELECT count(*),
        COALESCE(sum(CASE WHEN a.subject_id = NEW.buyer_subject_id AND a.account_kind = 'available'
          THEN e.amount_micros ELSE 0 END), 0),
        COALESCE(sum(CASE WHEN a.subject_id = NEW.supplier_subject_id AND a.account_kind = 'supplier_receivable'
          THEN e.amount_micros ELSE 0 END), 0)
      INTO entry_count, buyer_available_amount, supplier_receivable_amount
      FROM kai_credit_entries e JOIN kai_credit_accounts a ON a.id = e.account_id
      WHERE e.transaction_id = NEW.refund_transaction_id;
  END IF;
  SELECT EXISTS(SELECT 1 FROM subject_memberships m WHERE m.subject_id = NEW.supplier_subject_id
      AND m.user_id = NEW.approved_by_user_id AND m.status = 'active'
      AND m.role IN ('owner', 'admin', 'provider_manager')) INTO provider_valid;
  IF order_total IS DISTINCT FROM NEW.credit_micros OR reservation_status IS DISTINCT FROM 'captured'
    OR delivery_status IS DISTINCT FROM 'completed' OR sold_quantity < order_quantity
    OR EXISTS (SELECT 1 FROM kai_credit_supplier_settlements s WHERE s.order_id = NEW.order_id) THEN
    RAISE EXCEPTION 'invalid kai credit post acceptance refund state';
  END IF;
  IF OLD.status = 'pending' AND NEW.status = 'escalated' AND (
    order_status IS DISTINCT FROM 'accepted' OR NEW.approved_by_user_id IS NOT NULL
    OR NEW.refund_transaction_id IS NOT NULL OR NEW.resolved_at IS NOT NULL
  ) THEN RAISE EXCEPTION 'invalid kai credit post acceptance escalation'; END IF;
  IF NEW.status = 'succeeded' AND (
    order_status IS DISTINCT FROM 'refunded' OR NEW.resolved_at IS NULL OR NEW.resolved_at < NEW.requested_at
    OR transaction_status IS DISTINCT FROM 'posted'
    OR transaction_scope IS DISTINCT FROM CASE WHEN OLD.status = 'pending'
      THEN 'CREDIT_ORDER_POST_ACCEPT_REFUND' ELSE 'CREDIT_ORDER_POST_ACCEPT_ADJUDICATED_REFUND' END
    OR transaction_reference_type IS DISTINCT FROM 'refund' OR transaction_reference_id IS DISTINCT FROM NEW.order_id
    OR entry_count <> 2 OR buyer_available_amount <> NEW.credit_micros
    OR supplier_receivable_amount <> -NEW.credit_micros
    OR (OLD.status = 'pending' AND provider_valid IS DISTINCT FROM true)
    OR (OLD.status = 'escalated' AND NEW.approved_by_user_id IS NOT NULL)
  ) THEN RAISE EXCEPTION 'invalid kai credit post acceptance refund'; END IF;
  IF NEW.status = 'rejected' AND (
    order_status IS DISTINCT FROM 'accepted' OR NEW.approved_by_user_id IS NOT NULL
    OR NEW.refund_transaction_id IS NOT NULL OR NEW.resolved_at IS NULL OR NEW.resolved_at < NEW.requested_at
  ) THEN RAISE EXCEPTION 'invalid rejected kai credit post acceptance refund'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_kai_credit_post_acceptance_escalation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_status text;
DECLARE refund_order uuid;
DECLARE refund_status text;
DECLARE refund_requested_at timestamptz;
DECLARE order_buyer uuid;
DECLARE order_supplier uuid;
DECLARE member_valid boolean;
BEGIN
  SELECT status, buyer_subject_id, supplier_subject_id INTO order_status, order_buyer, order_supplier
    FROM kai_credit_orders WHERE id = NEW.order_id;
  SELECT order_id, status, requested_at INTO refund_order, refund_status, refund_requested_at
    FROM kai_credit_order_post_acceptance_refunds WHERE id = NEW.refund_id;
  SELECT EXISTS(SELECT 1 FROM subject_memberships m
    WHERE m.subject_id = CASE WHEN NEW.escalated_by_side = 'buyer' THEN NEW.buyer_subject_id ELSE NEW.supplier_subject_id END
      AND m.user_id = NEW.escalated_by_user_id AND m.status = 'active'
      AND ((NEW.escalated_by_side = 'buyer' AND m.role IN ('owner', 'admin'))
        OR (NEW.escalated_by_side = 'provider' AND m.role IN ('owner', 'admin', 'provider_manager'))))
    INTO member_valid;
  IF order_status IS DISTINCT FROM 'accepted' OR refund_order IS DISTINCT FROM NEW.order_id
    OR refund_status IS DISTINCT FROM 'escalated' OR order_buyer IS DISTINCT FROM NEW.buyer_subject_id
    OR order_supplier IS DISTINCT FROM NEW.supplier_subject_id OR member_valid IS DISTINCT FROM true
    OR (NEW.escalated_by_side = 'buyer' AND NEW.escalated_at < refund_requested_at + interval '24 hours')
    OR EXISTS (SELECT 1 FROM kai_credit_supplier_settlements s WHERE s.order_id = NEW.order_id) THEN
    RAISE EXCEPTION 'invalid kai credit post acceptance refund escalation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION protect_kai_credit_post_acceptance_escalation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'kai credit post acceptance refund escalations cannot be deleted'; END IF;
  IF NEW.id <> OLD.id OR NEW.order_id <> OLD.order_id OR NEW.refund_id <> OLD.refund_id
    OR NEW.buyer_subject_id <> OLD.buyer_subject_id OR NEW.supplier_subject_id <> OLD.supplier_subject_id
    OR NEW.escalated_by_user_id <> OLD.escalated_by_user_id OR NEW.escalated_by_side <> OLD.escalated_by_side
    OR NEW.provider_response_ciphertext IS DISTINCT FROM OLD.provider_response_ciphertext
    OR NEW.provider_response_digest IS DISTINCT FROM OLD.provider_response_digest
    OR NEW.escalated_at <> OLD.escalated_at OR NEW.created_at <> OLD.created_at
    OR OLD.status <> 'pending' OR NEW.status <> 'resolved' OR NEW.resolved_at IS NULL
    OR NEW.resolved_at < OLD.escalated_at THEN
    RAISE EXCEPTION 'invalid kai credit post acceptance refund escalation transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_kai_credit_post_acceptance_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_total bigint;
DECLARE order_status text;
DECLARE order_buyer uuid;
DECLARE order_supplier uuid;
DECLARE order_quantity numeric(24,6);
DECLARE refund_status text;
DECLARE escalation_status text;
DECLARE escalation_order uuid;
DECLARE reservation_status text;
DECLARE delivery_status text;
DECLARE transaction_status text;
DECLARE transaction_scope text;
DECLARE transaction_reference_type text;
DECLARE transaction_reference_id uuid;
DECLARE entry_count integer;
DECLARE buyer_available_amount bigint;
DECLARE supplier_receivable_amount bigint;
DECLARE operator_valid boolean;
DECLARE sold_quantity numeric(24,6);
BEGIN
  SELECT total_credit_micros, status, buyer_subject_id, supplier_subject_id, quantity
    INTO order_total, order_status, order_buyer, order_supplier, order_quantity
    FROM kai_credit_orders WHERE id = NEW.order_id;
  SELECT status INTO refund_status FROM kai_credit_order_post_acceptance_refunds
    WHERE id = NEW.refund_id AND order_id = NEW.order_id;
  SELECT status, order_id INTO escalation_status, escalation_order
    FROM kai_credit_post_acceptance_refund_escalations WHERE id = NEW.escalation_id AND refund_id = NEW.refund_id;
  SELECT status INTO reservation_status FROM kai_credit_order_reservations WHERE order_id = NEW.order_id;
  SELECT status INTO delivery_status FROM kai_credit_order_deliveries WHERE id = (
    SELECT a.delivery_attempt_id FROM kai_credit_order_acceptances a
    JOIN kai_credit_order_post_acceptance_refunds p ON p.acceptance_id = a.id WHERE p.id = NEW.refund_id);
  SELECT capacity_sold INTO sold_quantity FROM credit_market_listings
    WHERE id = (SELECT listing_id FROM kai_credit_orders WHERE id = NEW.order_id);
  IF NEW.refund_transaction_id IS NOT NULL THEN
    SELECT status, scope, reference_type, reference_id
      INTO transaction_status, transaction_scope, transaction_reference_type, transaction_reference_id
      FROM kai_credit_transactions WHERE id = NEW.refund_transaction_id;
    SELECT count(*),
        COALESCE(sum(CASE WHEN a.subject_id = order_buyer AND a.account_kind = 'available'
          THEN e.amount_micros ELSE 0 END), 0),
        COALESCE(sum(CASE WHEN a.subject_id = order_supplier AND a.account_kind = 'supplier_receivable'
          THEN e.amount_micros ELSE 0 END), 0)
      INTO entry_count, buyer_available_amount, supplier_receivable_amount
      FROM kai_credit_entries e JOIN kai_credit_accounts a ON a.id = e.account_id
      WHERE e.transaction_id = NEW.refund_transaction_id;
  END IF;
  SELECT EXISTS(SELECT 1 FROM users u WHERE u.id = NEW.operator_id
    AND u.role IN ('operator', 'admin') AND u.status = 'active') INTO operator_valid;
  IF escalation_status IS DISTINCT FROM 'resolved' OR escalation_order IS DISTINCT FROM NEW.order_id
    OR reservation_status IS DISTINCT FROM 'captured' OR delivery_status IS DISTINCT FROM 'completed'
    OR sold_quantity < order_quantity OR operator_valid IS DISTINCT FROM true
    OR EXISTS (SELECT 1 FROM kai_credit_supplier_settlements s WHERE s.order_id = NEW.order_id) THEN
    RAISE EXCEPTION 'invalid kai credit post acceptance refund decision';
  END IF;
  IF NEW.outcome = 'full_refund' AND (
    refund_status IS DISTINCT FROM 'succeeded' OR order_status IS DISTINCT FROM 'refunded'
    OR NEW.credit_micros <> order_total OR transaction_status IS DISTINCT FROM 'posted'
    OR transaction_scope IS DISTINCT FROM 'CREDIT_ORDER_POST_ACCEPT_ADJUDICATED_REFUND'
    OR transaction_reference_type IS DISTINCT FROM 'refund' OR transaction_reference_id IS DISTINCT FROM NEW.order_id
    OR entry_count <> 2 OR buyer_available_amount <> order_total
    OR supplier_receivable_amount <> -order_total
  ) THEN RAISE EXCEPTION 'invalid adjudicated post acceptance refund'; END IF;
  IF NEW.outcome = 'reject_refund' AND (
    refund_status IS DISTINCT FROM 'rejected' OR order_status IS DISTINCT FROM 'accepted'
    OR NEW.credit_micros <> 0 OR NEW.refund_transaction_id IS NOT NULL
  ) THEN RAISE EXCEPTION 'invalid rejected post acceptance refund decision'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_kai_credit_post_acceptance_decision_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE decision_order uuid;
DECLARE decision_operator uuid;
BEGIN
  SELECT order_id, operator_id INTO decision_order, decision_operator
    FROM kai_credit_post_acceptance_refund_decisions WHERE id = NEW.decision_id;
  IF decision_order IS DISTINCT FROM NEW.order_id OR decision_operator IS DISTINCT FROM NEW.operator_id THEN
    RAISE EXCEPTION 'invalid kai credit post acceptance refund decision request';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER kai_credit_post_acceptance_escalations_validate
  BEFORE INSERT ON kai_credit_post_acceptance_refund_escalations
  FOR EACH ROW EXECUTE FUNCTION validate_kai_credit_post_acceptance_escalation();
CREATE TRIGGER kai_credit_post_acceptance_escalations_guard
  BEFORE UPDATE OR DELETE ON kai_credit_post_acceptance_refund_escalations
  FOR EACH ROW EXECUTE FUNCTION protect_kai_credit_post_acceptance_escalation();
CREATE TRIGGER kai_credit_post_acceptance_decisions_validate
  BEFORE INSERT ON kai_credit_post_acceptance_refund_decisions
  FOR EACH ROW EXECUTE FUNCTION validate_kai_credit_post_acceptance_decision();
CREATE TRIGGER kai_credit_post_acceptance_decisions_immutable
  BEFORE UPDATE OR DELETE ON kai_credit_post_acceptance_refund_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER kai_credit_post_acceptance_decision_requests_validate
  BEFORE INSERT ON kai_credit_post_acceptance_refund_decision_requests
  FOR EACH ROW EXECUTE FUNCTION validate_kai_credit_post_acceptance_decision_request();
CREATE TRIGGER kai_credit_post_acceptance_decision_requests_immutable
  BEFORE UPDATE OR DELETE ON kai_credit_post_acceptance_refund_decision_requests
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE FUNCTION require_kai_credit_post_acceptance_escalation_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'escalated' AND NOT EXISTS (
    SELECT 1 FROM kai_credit_post_acceptance_refund_escalations e WHERE e.refund_id = NEW.id
  ) THEN RAISE EXCEPTION 'escalated post acceptance refund requires escalation record'; END IF;
  IF OLD.status = 'escalated' AND NEW.status IN ('succeeded', 'rejected') AND NOT EXISTS (
    SELECT 1 FROM kai_credit_post_acceptance_refund_decisions d WHERE d.refund_id = NEW.id
      AND ((NEW.status = 'succeeded' AND d.outcome = 'full_refund')
        OR (NEW.status = 'rejected' AND d.outcome = 'reject_refund'))
  ) THEN RAISE EXCEPTION 'resolved post acceptance refund requires matching decision'; END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION require_kai_credit_post_acceptance_decision_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'resolved' AND NOT EXISTS (
    SELECT 1 FROM kai_credit_post_acceptance_refund_decisions d WHERE d.escalation_id = NEW.id
  ) THEN RAISE EXCEPTION 'resolved post acceptance escalation requires decision'; END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER kai_credit_post_acceptance_refund_requires_escalation
  AFTER UPDATE OF status ON kai_credit_order_post_acceptance_refunds
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION require_kai_credit_post_acceptance_escalation_record();
CREATE CONSTRAINT TRIGGER kai_credit_post_acceptance_escalation_requires_decision
  AFTER UPDATE OF status ON kai_credit_post_acceptance_refund_escalations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION require_kai_credit_post_acceptance_decision_record();
