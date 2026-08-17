-- Unify compute and physical-device trade fees on one versioned 0.2%-1%
-- volume-decreasing policy. This migration deliberately creates and activates
-- no commercial policy: two distinct operators must propose and approve one.

CREATE TABLE kai_credit_fee_schedule_approvals (
  schedule_id uuid PRIMARY KEY REFERENCES kai_credit_fee_schedules(id),
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  approved_by_user_id uuid NOT NULL REFERENCES users(id),
  approval_request_id text NOT NULL CHECK (char_length(approval_request_id) BETWEEN 16 AND 120),
  approval_payload_digest text NOT NULL CHECK (char_length(approval_payload_digest) BETWEEN 16 AND 160),
  approved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (approved_by_user_id, approval_request_id),
  CHECK (approved_by_user_id <> requested_by_user_id)
);

CREATE TABLE kai_credit_fee_schedule_operator_requests (
  operator_id uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 16 AND 120),
  action text NOT NULL CHECK (action IN ('draft', 'approve_and_activate')),
  schedule_id uuid NOT NULL REFERENCES kai_credit_fee_schedules(id),
  payload_digest text NOT NULL CHECK (char_length(payload_digest) BETWEEN 16 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operator_id, idempotency_key)
);

CREATE TRIGGER kai_credit_fee_schedule_approvals_immutable
  BEFORE UPDATE OR DELETE ON kai_credit_fee_schedule_approvals
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER kai_credit_fee_schedule_operator_requests_immutable
  BEFORE UPDATE OR DELETE ON kai_credit_fee_schedule_operator_requests
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE FUNCTION require_four_eyes_fee_schedule_activation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE approval kai_credit_fee_schedule_approvals%ROWTYPE;
BEGIN
  IF OLD.status = 'draft' AND NEW.status = 'active' THEN
    SELECT * INTO approval FROM kai_credit_fee_schedule_approvals WHERE schedule_id = NEW.id;
    IF approval.schedule_id IS NULL
      OR approval.requested_by_user_id IS DISTINCT FROM NEW.created_by_user_id
      OR approval.approved_by_user_id IS DISTINCT FROM NEW.activated_by_user_id
      OR NEW.activated_by_user_id = NEW.created_by_user_id THEN
      RAISE EXCEPTION 'fee schedule activation requires independent operator approval';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER kai_credit_fee_schedules_four_eyes
  BEFORE UPDATE ON kai_credit_fee_schedules
  FOR EACH ROW EXECUTE FUNCTION require_four_eyes_fee_schedule_activation();

DROP TRIGGER kai_credit_orders_grandfather_fee_policy ON kai_credit_orders;
DROP FUNCTION grandfather_kai_credit_order_fee_policy();

CREATE FUNCTION lock_kai_credit_order_fee_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE active_schedule kai_credit_fee_schedules%ROWTYPE;
BEGIN
  SELECT * INTO active_schedule FROM kai_credit_fee_schedules
    WHERE fee_category = 'compute_trade' AND status = 'active'
      AND effective_from <= NEW.created_at
    ORDER BY effective_from DESC, id DESC LIMIT 1 FOR SHARE;
  IF active_schedule.id IS NULL THEN
    RAISE EXCEPTION 'active trade fee schedule required';
  END IF;
  INSERT INTO kai_credit_order_fee_policies(order_id, policy_state, schedule_id,
    schedule_version, locked_at)
  VALUES (NEW.id, 'schedule_locked', active_schedule.id, active_schedule.version, NEW.created_at);
  RETURN NEW;
END;
$$;
CREATE TRIGGER kai_credit_orders_lock_fee_policy
  AFTER INSERT ON kai_credit_orders FOR EACH ROW EXECUTE FUNCTION lock_kai_credit_order_fee_policy();

ALTER TABLE compute_fulfillment_supplier_settlements
  ADD COLUMN service_fee_credit_micros bigint NOT NULL DEFAULT 0
    CHECK (service_fee_credit_micros >= 0 AND service_fee_credit_micros <= credit_micros),
  ADD COLUMN net_credit_micros bigint GENERATED ALWAYS AS
    (credit_micros - service_fee_credit_micros) STORED;

CREATE TABLE physical_device_fee_assessments (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES physical_device_orders(id),
  supplier_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  schedule_id uuid NOT NULL,
  schedule_version text NOT NULL,
  period_id uuid NOT NULL REFERENCES kai_credit_supplier_fee_periods(id),
  period_start date NOT NULL,
  payload_digest text NOT NULL CHECK (char_length(payload_digest) BETWEEN 16 AND 160),
  gross_credit_micros bigint NOT NULL CHECK (gross_credit_micros > 0),
  service_fee_credit_micros bigint NOT NULL CHECK (
    service_fee_credit_micros > 0 AND service_fee_credit_micros < gross_credit_micros
  ),
  net_credit_micros bigint NOT NULL CHECK (net_credit_micros > 0),
  cumulative_before_micros bigint NOT NULL CHECK (cumulative_before_micros >= 0),
  cumulative_after_micros bigint NOT NULL CHECK (
    cumulative_after_micros = cumulative_before_micros + gross_credit_micros
  ),
  ledger_transaction_id uuid NOT NULL UNIQUE REFERENCES kai_credit_transactions(id),
  assessed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (schedule_id, schedule_version)
    REFERENCES kai_credit_fee_schedules(id, version),
  CHECK (net_credit_micros = gross_credit_micros - service_fee_credit_micros)
);

CREATE TABLE physical_device_fee_assessment_segments (
  id uuid PRIMARY KEY,
  assessment_id uuid NOT NULL REFERENCES physical_device_fee_assessments(id),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  tier_ordinal integer NOT NULL CHECK (tier_ordinal >= 0),
  lower_bound_micros bigint NOT NULL CHECK (lower_bound_micros >= 0),
  upper_bound_micros bigint,
  settled_credit_micros bigint NOT NULL CHECK (settled_credit_micros > 0),
  rate_bps integer NOT NULL CHECK (rate_bps BETWEEN 20 AND 100),
  exact_fee_numerator numeric(38,0) NOT NULL CHECK (exact_fee_numerator >= 0),
  service_fee_credit_micros bigint NOT NULL CHECK (service_fee_credit_micros >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assessment_id, ordinal),
  CHECK (upper_bound_micros IS NULL OR upper_bound_micros > lower_bound_micros)
);

CREATE TRIGGER physical_device_fee_assessments_immutable
  BEFORE UPDATE OR DELETE ON physical_device_fee_assessments
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER physical_device_fee_assessment_segments_immutable
  BEFORE UPDATE OR DELETE ON physical_device_fee_assessment_segments
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE FUNCTION validate_physical_device_fee_assessment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_supplier uuid;
DECLARE order_buyer uuid;
DECLARE order_gross bigint;
DECLARE order_status text;
DECLARE period_supplier uuid;
DECLARE period_date date;
DECLARE transaction_status text;
DECLARE transaction_scope text;
DECLARE transaction_reference_id text;
DECLARE entry_count integer;
DECLARE buyer_reserved_amount bigint;
DECLARE supplier_receivable_amount bigint;
DECLARE platform_revenue_amount bigint;
BEGIN
  SELECT supplier_subject_id, buyer_subject_id, gross_credit_micros, status
    INTO order_supplier, order_buyer, order_gross, order_status
    FROM physical_device_orders WHERE id = NEW.order_id;
  SELECT supplier_subject_id, period_start INTO period_supplier, period_date
    FROM kai_credit_supplier_fee_periods WHERE id = NEW.period_id;
  SELECT status, scope, reference_id
    INTO transaction_status, transaction_scope, transaction_reference_id
    FROM kai_credit_transactions WHERE id = NEW.ledger_transaction_id;
  SELECT count(*),
      COALESCE(sum(CASE WHEN a.subject_id = order_buyer AND a.account_kind = 'reserved'
        THEN e.amount_micros ELSE 0 END), 0),
      COALESCE(sum(CASE WHEN a.subject_id = NEW.supplier_subject_id AND a.account_kind = 'supplier_receivable'
        THEN e.amount_micros ELSE 0 END), 0),
      COALESCE(sum(CASE WHEN a.id = '00000000-0000-4000-8000-000000000103'
        THEN e.amount_micros ELSE 0 END), 0)
    INTO entry_count, buyer_reserved_amount, supplier_receivable_amount, platform_revenue_amount
    FROM kai_credit_entries e JOIN kai_credit_accounts a ON a.id = e.account_id
    WHERE e.transaction_id = NEW.ledger_transaction_id;
  IF order_supplier IS DISTINCT FROM NEW.supplier_subject_id OR order_gross <> NEW.gross_credit_micros
    OR order_status IS DISTINCT FROM 'shipping'
    OR period_supplier IS DISTINCT FROM NEW.supplier_subject_id OR period_date IS DISTINCT FROM NEW.period_start
    OR transaction_status IS DISTINCT FROM 'posted' OR transaction_scope IS DISTINCT FROM 'DEVICE_ORDER_CAPTURE'
    OR transaction_reference_id IS DISTINCT FROM NEW.order_id::text OR entry_count <> 3
    OR buyer_reserved_amount <> -NEW.gross_credit_micros
    OR supplier_receivable_amount <> NEW.net_credit_micros
    OR platform_revenue_amount <> NEW.service_fee_credit_micros THEN
    RAISE EXCEPTION 'invalid physical device fee assessment';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER physical_device_fee_assessments_validate
  BEFORE INSERT ON physical_device_fee_assessments
  FOR EACH ROW EXECUTE FUNCTION validate_physical_device_fee_assessment();

CREATE FUNCTION require_balanced_physical_device_fee_segments() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE assessment_gross bigint;
DECLARE assessment_fee bigint;
DECLARE segment_gross numeric;
DECLARE segment_fee numeric;
BEGIN
  SELECT gross_credit_micros, service_fee_credit_micros INTO assessment_gross, assessment_fee
    FROM physical_device_fee_assessments WHERE id = NEW.assessment_id;
  SELECT COALESCE(sum(settled_credit_micros), 0), COALESCE(sum(service_fee_credit_micros), 0)
    INTO segment_gross, segment_fee FROM physical_device_fee_assessment_segments
    WHERE assessment_id = NEW.assessment_id;
  IF segment_gross <> assessment_gross OR segment_fee <> assessment_fee THEN
    RAISE EXCEPTION 'physical device fee segments do not balance';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER physical_device_fee_segments_balance
  AFTER INSERT ON physical_device_fee_assessment_segments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_balanced_physical_device_fee_segments();

-- The standard delivery settlement now records gross, fee and net against the
-- independently redeemable supplier earnings account.
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
DECLARE supplier_earnings_amount bigint;
DECLARE receivable_amount bigint;
DECLARE platform_revenue_amount bigint;
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
      COALESCE(sum(CASE WHEN a.subject_id = NEW.supplier_subject_id
        AND a.account_kind = 'supplier_earnings_available' THEN e.amount_micros ELSE 0 END), 0),
      COALESCE(sum(CASE WHEN a.subject_id = NEW.supplier_subject_id
        AND a.account_kind = 'supplier_receivable' THEN e.amount_micros ELSE 0 END), 0),
      COALESCE(sum(CASE WHEN a.id = '00000000-0000-4000-8000-000000000103'
        THEN e.amount_micros ELSE 0 END), 0)
    INTO entry_count, supplier_earnings_amount, receivable_amount, platform_revenue_amount
    FROM kai_credit_entries e JOIN kai_credit_accounts a ON a.id = e.account_id
    WHERE e.transaction_id = NEW.settlement_transaction_id;
  IF order_status IS DISTINCT FROM 'closed' OR order_supplier IS DISTINCT FROM NEW.supplier_subject_id
    OR NEW.credit_micros <> order_total - refunded_total OR NEW.credit_micros <= 0
    OR acceptance_order IS DISTINCT FROM NEW.order_id
    OR NEW.available_at IS DISTINCT FROM acceptance_time + interval '7 days'
    OR reservation_status IS DISTINCT FROM 'captured'
    OR transaction_status IS DISTINCT FROM 'posted'
    OR transaction_scope IS DISTINCT FROM 'CREDIT_SUPPLIER_SETTLEMENT_WITH_FEE'
    OR entry_count <> 3
    OR supplier_earnings_amount <> NEW.net_credit_micros
    OR receivable_amount <> -NEW.credit_micros
    OR platform_revenue_amount <> NEW.service_fee_credit_micros THEN
    RAISE EXCEPTION 'invalid kai credit supplier settlement';
  END IF;
  RETURN NEW;
END;
$$;
