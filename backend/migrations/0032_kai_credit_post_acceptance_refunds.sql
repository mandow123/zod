CREATE TABLE kai_credit_order_post_acceptance_refunds (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES kai_credit_orders(id),
  acceptance_id uuid NOT NULL UNIQUE REFERENCES kai_credit_order_acceptances(id),
  buyer_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  supplier_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  description_ciphertext text NOT NULL CHECK (char_length(description_ciphertext) BETWEEN 16 AND 12000),
  description_digest text NOT NULL CHECK (char_length(description_digest) BETWEEN 16 AND 160),
  credit_micros bigint NOT NULL CHECK (credit_micros > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded')),
  approved_by_user_id uuid REFERENCES users(id),
  refund_transaction_id uuid UNIQUE REFERENCES kai_credit_transactions(id),
  requested_at timestamptz NOT NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'pending' AND approved_by_user_id IS NULL AND refund_transaction_id IS NULL AND resolved_at IS NULL)
    OR (status = 'succeeded' AND approved_by_user_id IS NOT NULL
      AND refund_transaction_id IS NOT NULL AND resolved_at IS NOT NULL)
  ),
  FOREIGN KEY (order_id, buyer_subject_id) REFERENCES kai_credit_orders(id, buyer_subject_id),
  FOREIGN KEY (order_id, supplier_subject_id) REFERENCES kai_credit_orders(id, supplier_subject_id)
);
CREATE INDEX kai_credit_post_acceptance_refunds_supplier_pending
  ON kai_credit_order_post_acceptance_refunds(supplier_subject_id, requested_at, id) WHERE status = 'pending';

ALTER TABLE kai_credit_order_action_requests
  DROP CONSTRAINT kai_credit_order_action_requests_action_check,
  DROP CONSTRAINT kai_credit_order_action_requests_result_check,
  ADD CONSTRAINT kai_credit_order_action_requests_action_check CHECK (
    action IN ('confirm', 'cancel', 'start_delivery', 'delivery_ready', 'accept',
      'report_delivery_issue', 'start_rework', 'approve_refund', 'settle', 'escalate_dispute',
      'request_post_acceptance_refund', 'approve_post_acceptance_refund')
  ),
  ADD CONSTRAINT kai_credit_order_action_requests_result_check CHECK (
    result IN ('confirmed', 'cancelled', 'expired', 'provisioning', 'acceptance_pending', 'accepted',
      'disputed', 'refunded', 'settled', 'escalated', 'aftercare_pending', 'invalid_state')
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
    OR (OLD.status = 'disputed' AND NEW.status IN ('provisioning', 'refunded', 'acceptance_pending'))
    OR (OLD.status = 'accepted' AND NEW.status IN ('closed', 'refunded'))
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

CREATE FUNCTION validate_kai_credit_post_acceptance_refund_insert() RETURNS trigger LANGUAGE plpgsql AS $$
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
    OR order_status IS DISTINCT FROM 'accepted' OR order_total IS DISTINCT FROM NEW.credit_micros
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

CREATE FUNCTION protect_kai_credit_post_acceptance_refund() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF OLD.status <> 'pending' OR NEW.status <> 'succeeded' THEN
    RAISE EXCEPTION 'invalid kai credit post acceptance refund transition';
  END IF;
  SELECT status, total_credit_micros, quantity INTO order_status, order_total, order_quantity
    FROM kai_credit_orders WHERE id = NEW.order_id;
  SELECT status INTO reservation_status FROM kai_credit_order_reservations WHERE order_id = NEW.order_id;
  SELECT status INTO delivery_status FROM kai_credit_order_deliveries
    WHERE id = (SELECT delivery_attempt_id FROM kai_credit_order_acceptances WHERE id = NEW.acceptance_id);
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
  SELECT EXISTS(SELECT 1 FROM subject_memberships m WHERE m.subject_id = NEW.supplier_subject_id
      AND m.user_id = NEW.approved_by_user_id AND m.status = 'active'
      AND m.role IN ('owner', 'admin', 'provider_manager')) INTO provider_valid;
  SELECT capacity_sold INTO sold_quantity FROM credit_market_listings
    WHERE id = (SELECT listing_id FROM kai_credit_orders WHERE id = NEW.order_id);
  IF order_status IS DISTINCT FROM 'refunded' OR order_total IS DISTINCT FROM NEW.credit_micros
    OR reservation_status IS DISTINCT FROM 'captured' OR delivery_status IS DISTINCT FROM 'completed'
    OR transaction_status IS DISTINCT FROM 'posted' OR transaction_scope IS DISTINCT FROM 'CREDIT_ORDER_POST_ACCEPT_REFUND'
    OR transaction_reference_type IS DISTINCT FROM 'refund' OR transaction_reference_id IS DISTINCT FROM NEW.order_id
    OR entry_count <> 2 OR buyer_available_amount <> NEW.credit_micros
    OR supplier_receivable_amount <> -NEW.credit_micros OR provider_valid IS DISTINCT FROM true
    OR sold_quantity < order_quantity OR NEW.resolved_at IS NULL OR NEW.resolved_at < NEW.requested_at
    OR EXISTS (SELECT 1 FROM kai_credit_supplier_settlements s WHERE s.order_id = NEW.order_id) THEN
    RAISE EXCEPTION 'invalid kai credit post acceptance refund';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER kai_credit_post_acceptance_refunds_validate_insert
  BEFORE INSERT ON kai_credit_order_post_acceptance_refunds
  FOR EACH ROW EXECUTE FUNCTION validate_kai_credit_post_acceptance_refund_insert();
CREATE TRIGGER kai_credit_post_acceptance_refunds_guard
  BEFORE UPDATE OR DELETE ON kai_credit_order_post_acceptance_refunds
  FOR EACH ROW EXECUTE FUNCTION protect_kai_credit_post_acceptance_refund();

CREATE OR REPLACE FUNCTION require_kai_credit_refund_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'refunded'
    AND NOT EXISTS (SELECT 1 FROM kai_credit_order_mutual_refunds r WHERE r.order_id = NEW.id)
    AND NOT EXISTS (SELECT 1 FROM kai_credit_order_dispute_decisions d
      WHERE d.order_id = NEW.id AND d.outcome = 'full_refund')
    AND NOT EXISTS (SELECT 1 FROM kai_credit_order_post_acceptance_refunds p
      WHERE p.order_id = NEW.id AND p.status = 'succeeded') THEN
    RAISE EXCEPTION 'refunded kai credit order requires refund record';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION require_kai_credit_post_acceptance_request_for_refund() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'accepted' AND NEW.status = 'refunded' AND NOT EXISTS (
    SELECT 1 FROM kai_credit_order_post_acceptance_refunds p
      WHERE p.order_id = NEW.id AND p.status = 'succeeded'
  ) THEN RAISE EXCEPTION 'post acceptance refund requires succeeded request'; END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER kai_credit_post_acceptance_refund_requires_request
  AFTER UPDATE OF status ON kai_credit_orders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_kai_credit_post_acceptance_request_for_refund();
