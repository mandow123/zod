ALTER TABLE kai_credit_post_acceptance_refund_decisions
  DROP CONSTRAINT kai_credit_post_acceptance_refund_decisions_outcome_check,
  DROP CONSTRAINT kai_credit_post_acceptance_refund_decisions_check,
  ADD CONSTRAINT kai_credit_post_acceptance_refund_decisions_outcome_check CHECK (
    outcome IN ('full_refund', 'partial_refund', 'reject_refund')
  ),
  ADD CONSTRAINT kai_credit_post_acceptance_refund_decisions_resolution_check CHECK (
    (outcome IN ('full_refund', 'partial_refund') AND credit_micros > 0 AND refund_transaction_id IS NOT NULL)
    OR (outcome = 'reject_refund' AND credit_micros = 0 AND refund_transaction_id IS NULL)
  );

CREATE OR REPLACE FUNCTION validate_kai_credit_post_acceptance_refund_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_status text;
DECLARE order_total bigint;
DECLARE order_buyer uuid;
DECLARE order_supplier uuid;
DECLARE acceptance_order uuid;
DECLARE acceptance_time timestamptz;
DECLARE reservation_status text;
DECLARE delivery_status text;
DECLARE member_valid boolean;
BEGIN
  SELECT status, total_credit_micros, buyer_subject_id, supplier_subject_id
    INTO order_status, order_total, order_buyer, order_supplier
    FROM kai_credit_orders WHERE id = NEW.order_id;
  SELECT order_id, accepted_at INTO acceptance_order, acceptance_time
    FROM kai_credit_order_acceptances WHERE id = NEW.acceptance_id;
  SELECT status INTO reservation_status FROM kai_credit_order_reservations WHERE order_id = NEW.order_id;
  SELECT status INTO delivery_status FROM kai_credit_order_deliveries
    WHERE id = (SELECT delivery_attempt_id FROM kai_credit_order_acceptances WHERE id = NEW.acceptance_id);
  SELECT EXISTS(SELECT 1 FROM subject_memberships m WHERE m.subject_id = NEW.buyer_subject_id
      AND m.user_id = NEW.requested_by_user_id AND m.status = 'active'
      AND m.role IN ('owner', 'admin')) INTO member_valid;
  IF NEW.status IS DISTINCT FROM 'pending'
    OR order_status IS DISTINCT FROM 'accepted' OR NEW.credit_micros <= 0 OR NEW.credit_micros > order_total
    OR order_buyer IS DISTINCT FROM NEW.buyer_subject_id OR order_supplier IS DISTINCT FROM NEW.supplier_subject_id
    OR acceptance_order IS DISTINCT FROM NEW.order_id OR NEW.requested_at < acceptance_time
    OR NEW.requested_at >= acceptance_time + interval '7 days'
    OR reservation_status IS DISTINCT FROM 'captured' OR delivery_status IS DISTINCT FROM 'completed'
    OR member_valid IS DISTINCT FROM true
    OR EXISTS (SELECT 1 FROM kai_credit_supplier_settlements s WHERE s.order_id = NEW.order_id) THEN
    RAISE EXCEPTION 'invalid kai credit post acceptance refund request';
  END IF;
  RETURN NEW;
END;
$$;

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
  IF NEW.credit_micros <= 0 OR NEW.credit_micros > order_total
    OR reservation_status IS DISTINCT FROM 'captured' OR delivery_status IS DISTINCT FROM 'completed'
    OR sold_quantity < order_quantity
    OR EXISTS (SELECT 1 FROM kai_credit_supplier_settlements s WHERE s.order_id = NEW.order_id) THEN
    RAISE EXCEPTION 'invalid kai credit post acceptance refund state';
  END IF;
  IF OLD.status = 'pending' AND NEW.status = 'escalated' AND (
    order_status IS DISTINCT FROM 'accepted' OR NEW.approved_by_user_id IS NOT NULL
    OR NEW.refund_transaction_id IS NOT NULL OR NEW.resolved_at IS NOT NULL
  ) THEN RAISE EXCEPTION 'invalid kai credit post acceptance escalation'; END IF;
  IF NEW.status = 'succeeded' AND (
    order_status IS DISTINCT FROM CASE WHEN NEW.credit_micros = order_total THEN 'refunded' ELSE 'accepted' END
    OR NEW.resolved_at IS NULL OR NEW.resolved_at < NEW.requested_at
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

CREATE OR REPLACE FUNCTION validate_kai_credit_post_acceptance_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_total bigint;
DECLARE order_status text;
DECLARE order_buyer uuid;
DECLARE order_supplier uuid;
DECLARE order_quantity numeric(24,6);
DECLARE refund_status text;
DECLARE refund_amount bigint;
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
  SELECT status, credit_micros INTO refund_status, refund_amount FROM kai_credit_order_post_acceptance_refunds
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
  IF NEW.outcome IN ('full_refund', 'partial_refund') AND (
    refund_status IS DISTINCT FROM 'succeeded'
    OR order_status IS DISTINCT FROM CASE WHEN NEW.outcome = 'full_refund' THEN 'refunded' ELSE 'accepted' END
    OR (NEW.outcome = 'full_refund') IS DISTINCT FROM (refund_amount = order_total)
    OR NEW.credit_micros <> refund_amount OR transaction_status IS DISTINCT FROM 'posted'
    OR transaction_scope IS DISTINCT FROM 'CREDIT_ORDER_POST_ACCEPT_ADJUDICATED_REFUND'
    OR transaction_reference_type IS DISTINCT FROM 'refund' OR transaction_reference_id IS DISTINCT FROM NEW.order_id
    OR entry_count <> 2 OR buyer_available_amount <> refund_amount
    OR supplier_receivable_amount <> -refund_amount
  ) THEN RAISE EXCEPTION 'invalid adjudicated post acceptance refund'; END IF;
  IF NEW.outcome = 'reject_refund' AND (
    refund_status IS DISTINCT FROM 'rejected' OR order_status IS DISTINCT FROM 'accepted'
    OR NEW.credit_micros <> 0 OR NEW.refund_transaction_id IS NOT NULL
  ) THEN RAISE EXCEPTION 'invalid rejected post acceptance refund decision'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION require_kai_credit_post_acceptance_escalation_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'escalated' AND NOT EXISTS (
    SELECT 1 FROM kai_credit_post_acceptance_refund_escalations e WHERE e.refund_id = NEW.id
  ) THEN RAISE EXCEPTION 'escalated post acceptance refund requires escalation record'; END IF;
  IF OLD.status = 'escalated' AND NEW.status IN ('succeeded', 'rejected') AND NOT EXISTS (
    SELECT 1 FROM kai_credit_post_acceptance_refund_decisions d WHERE d.refund_id = NEW.id
      AND ((NEW.status = 'succeeded' AND d.outcome IN ('full_refund', 'partial_refund'))
        OR (NEW.status = 'rejected' AND d.outcome = 'reject_refund'))
  ) THEN RAISE EXCEPTION 'resolved post acceptance refund requires matching decision'; END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION validate_kai_credit_supplier_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_total bigint;
DECLARE refunded_total bigint;
DECLARE order_status text;
DECLARE order_supplier uuid;
DECLARE acceptance_order uuid;
DECLARE acceptance_time timestamptz;
DECLARE reservation_status text;
DECLARE transaction_status text;
DECLARE transaction_scope text;
DECLARE entry_count integer;
DECLARE available_amount bigint;
DECLARE receivable_amount bigint;
BEGIN
  SELECT total_credit_micros, status, supplier_subject_id
    INTO order_total, order_status, order_supplier FROM kai_credit_orders WHERE id = NEW.order_id;
  SELECT COALESCE(sum(credit_micros), 0) INTO refunded_total
    FROM kai_credit_order_post_acceptance_refunds WHERE order_id = NEW.order_id AND status = 'succeeded';
  SELECT order_id, accepted_at INTO acceptance_order, acceptance_time
    FROM kai_credit_order_acceptances WHERE id = NEW.acceptance_id;
  SELECT status INTO reservation_status FROM kai_credit_order_reservations WHERE order_id = NEW.order_id;
  SELECT status, scope INTO transaction_status, transaction_scope
    FROM kai_credit_transactions WHERE id = NEW.settlement_transaction_id;
  SELECT count(*),
      COALESCE(sum(CASE WHEN a.subject_id = NEW.supplier_subject_id AND a.account_kind = 'available'
        THEN e.amount_micros ELSE 0 END), 0),
      COALESCE(sum(CASE WHEN a.subject_id = NEW.supplier_subject_id AND a.account_kind = 'supplier_receivable'
        THEN e.amount_micros ELSE 0 END), 0)
    INTO entry_count, available_amount, receivable_amount
    FROM kai_credit_entries e JOIN kai_credit_accounts a ON a.id = e.account_id
    WHERE e.transaction_id = NEW.settlement_transaction_id;
  IF order_status IS DISTINCT FROM 'closed' OR order_supplier IS DISTINCT FROM NEW.supplier_subject_id
    OR NEW.credit_micros <> order_total - refunded_total OR NEW.credit_micros <= 0
    OR acceptance_order IS DISTINCT FROM NEW.order_id
    OR NEW.available_at IS DISTINCT FROM acceptance_time + interval '7 days'
    OR reservation_status IS DISTINCT FROM 'captured'
    OR transaction_status IS DISTINCT FROM 'posted' OR transaction_scope IS DISTINCT FROM 'CREDIT_SUPPLIER_SETTLEMENT'
    OR entry_count <> 2 OR available_amount <> NEW.credit_micros OR receivable_amount <> -NEW.credit_micros THEN
    RAISE EXCEPTION 'invalid kai credit supplier settlement';
  END IF;
  RETURN NEW;
END;
$$;
