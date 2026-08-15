CREATE TABLE kai_credit_supplier_settlements (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES kai_credit_orders(id),
  acceptance_id uuid NOT NULL UNIQUE REFERENCES kai_credit_order_acceptances(id),
  supplier_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  triggered_by text NOT NULL CHECK (triggered_by IN ('provider', 'system')),
  settled_by_user_id uuid REFERENCES users(id),
  credit_micros bigint NOT NULL CHECK (credit_micros > 0),
  settlement_transaction_id uuid NOT NULL UNIQUE REFERENCES kai_credit_transactions(id),
  status text NOT NULL CHECK (status = 'succeeded'),
  available_at timestamptz NOT NULL,
  settled_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((triggered_by = 'provider') = (settled_by_user_id IS NOT NULL)),
  CHECK (settled_at >= available_at),
  FOREIGN KEY (order_id, supplier_subject_id) REFERENCES kai_credit_orders(id, supplier_subject_id)
);

ALTER TABLE kai_credit_order_action_requests
  DROP CONSTRAINT kai_credit_order_action_requests_action_check,
  DROP CONSTRAINT kai_credit_order_action_requests_result_check,
  ADD CONSTRAINT kai_credit_order_action_requests_action_check CHECK (
    action IN ('confirm', 'cancel', 'start_delivery', 'delivery_ready', 'accept',
      'report_delivery_issue', 'start_rework', 'approve_refund', 'settle')
  ),
  ADD CONSTRAINT kai_credit_order_action_requests_result_check CHECK (
    result IN ('confirmed', 'cancelled', 'expired', 'provisioning', 'acceptance_pending', 'accepted',
      'disputed', 'refunded', 'settled', 'invalid_state')
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
    OR (OLD.status = 'disputed' AND NEW.status IN ('provisioning', 'refunded'))
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

CREATE FUNCTION validate_kai_credit_supplier_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_total bigint;
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
    INTO order_total, order_status, order_supplier
    FROM kai_credit_orders WHERE id = NEW.order_id;
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
    OR NEW.credit_micros <> order_total OR acceptance_order IS DISTINCT FROM NEW.order_id
    OR NEW.available_at IS DISTINCT FROM acceptance_time + interval '7 days'
    OR reservation_status IS DISTINCT FROM 'captured'
    OR transaction_status IS DISTINCT FROM 'posted' OR transaction_scope IS DISTINCT FROM 'CREDIT_SUPPLIER_SETTLEMENT'
    OR entry_count <> 2 OR available_amount <> NEW.credit_micros OR receivable_amount <> -NEW.credit_micros THEN
    RAISE EXCEPTION 'invalid kai credit supplier settlement';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER kai_credit_supplier_settlements_validate
  BEFORE INSERT ON kai_credit_supplier_settlements
  FOR EACH ROW EXECUTE FUNCTION validate_kai_credit_supplier_settlement();
CREATE TRIGGER kai_credit_supplier_settlements_immutable
  BEFORE UPDATE OR DELETE ON kai_credit_supplier_settlements
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE FUNCTION require_kai_credit_supplier_settlement_for_closed_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'closed' AND NOT EXISTS (
    SELECT 1 FROM kai_credit_supplier_settlements s WHERE s.order_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'closed kai credit order requires supplier settlement';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER kai_credit_closed_order_requires_settlement
  AFTER INSERT OR UPDATE OF status ON kai_credit_orders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION require_kai_credit_supplier_settlement_for_closed_order();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM kai_credit_orders WHERE status = 'closed') THEN
    RAISE EXCEPTION 'existing closed kai credit orders require migration review';
  END IF;
END;
$$;
