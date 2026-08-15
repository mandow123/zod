-- Versioned KAI-credit settlement service fees. This migration deliberately
-- activates no schedule and does not attach fee charging to the live order
-- settlement path. Existing orders are explicitly grandfathered so a future
-- cut-over cannot charge them retroactively.

ALTER TABLE kai_credit_transactions
  DROP CONSTRAINT kai_credit_transactions_reference_type_check,
  ADD CONSTRAINT kai_credit_transactions_reference_type_check CHECK (reference_type IN (
    'topup', 'order_reservation', 'order_release', 'order_capture', 'refund', 'settlement',
    'service_fee', 'service_fee_reversal', 'adjustment'
  ));

-- Keep the existing settlement amount as gross. The live path still writes a
-- zero fee, while the controlled cut-over can populate the fee and net fields
-- without changing the established gross meaning.
ALTER TABLE kai_credit_supplier_settlements
  ADD COLUMN service_fee_credit_micros bigint NOT NULL DEFAULT 0
    CHECK (service_fee_credit_micros >= 0 AND service_fee_credit_micros <= credit_micros),
  ADD COLUMN net_credit_micros bigint GENERATED ALWAYS AS
    (credit_micros - service_fee_credit_micros) STORED;

CREATE TABLE kai_credit_fee_schedules (
  id uuid PRIMARY KEY,
  version text NOT NULL UNIQUE CHECK (version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,39}$'),
  fee_category text NOT NULL CHECK (fee_category = 'compute_trade'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  currency text NOT NULL DEFAULT 'KAI_CREDIT' CHECK (currency = 'KAI_CREDIT'),
  timezone text NOT NULL DEFAULT 'Asia/Shanghai' CHECK (timezone = 'Asia/Shanghai'),
  rounding_model text NOT NULL DEFAULT 'cumulative_ceiling_v1'
    CHECK (rounding_model = 'cumulative_ceiling_v1'),
  effective_from timestamptz,
  effective_to timestamptz,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  activated_by_user_id uuid REFERENCES users(id),
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, version),
  CHECK (
    (status = 'draft' AND effective_from IS NULL AND effective_to IS NULL
      AND activated_by_user_id IS NULL AND activated_at IS NULL)
    OR (status = 'active' AND effective_from IS NOT NULL AND effective_to IS NULL
      AND activated_by_user_id IS NOT NULL AND activated_at IS NOT NULL)
    OR (status = 'retired' AND effective_from IS NOT NULL AND effective_to IS NOT NULL
      AND activated_by_user_id IS NOT NULL AND activated_at IS NOT NULL
      AND effective_to >= effective_from)
  )
);
CREATE UNIQUE INDEX kai_credit_fee_schedules_one_active
  ON kai_credit_fee_schedules(fee_category) WHERE status = 'active';

CREATE TABLE kai_credit_fee_tiers (
  id uuid PRIMARY KEY,
  schedule_id uuid NOT NULL REFERENCES kai_credit_fee_schedules(id),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  lower_bound_micros bigint NOT NULL CHECK (lower_bound_micros >= 0),
  upper_bound_micros bigint CHECK (upper_bound_micros > lower_bound_micros),
  rate_bps integer NOT NULL CHECK (rate_bps BETWEEN 20 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, ordinal),
  UNIQUE (schedule_id, lower_bound_micros)
);

CREATE TABLE kai_credit_order_fee_policies (
  order_id uuid PRIMARY KEY REFERENCES kai_credit_orders(id),
  policy_state text NOT NULL CHECK (policy_state IN ('grandfathered_no_fee', 'schedule_locked')),
  schedule_id uuid,
  schedule_version text,
  locked_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (policy_state = 'grandfathered_no_fee' AND schedule_id IS NULL AND schedule_version IS NULL)
    OR (policy_state = 'schedule_locked' AND schedule_id IS NOT NULL AND schedule_version IS NOT NULL)
  ),
  FOREIGN KEY (schedule_id, schedule_version)
    REFERENCES kai_credit_fee_schedules(id, version) MATCH FULL
);

INSERT INTO kai_credit_order_fee_policies(order_id, policy_state, locked_at)
SELECT id, 'grandfathered_no_fee', created_at FROM kai_credit_orders;

-- Until the later controlled cut-over replaces this trigger, every new order
-- is also protected from retroactive fees. No active schedule is inferred.
CREATE FUNCTION grandfather_kai_credit_order_fee_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO kai_credit_order_fee_policies(order_id, policy_state, locked_at)
  VALUES (NEW.id, 'grandfathered_no_fee', NEW.created_at);
  RETURN NEW;
END;
$$;
CREATE TRIGGER kai_credit_orders_grandfather_fee_policy
  AFTER INSERT ON kai_credit_orders FOR EACH ROW EXECUTE FUNCTION grandfather_kai_credit_order_fee_policy();

CREATE TABLE kai_credit_supplier_fee_periods (
  id uuid PRIMARY KEY,
  supplier_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  fee_category text NOT NULL CHECK (fee_category = 'compute_trade'),
  period_start date NOT NULL CHECK (period_start = date_trunc('month', period_start)::date),
  timezone text NOT NULL DEFAULT 'Asia/Shanghai' CHECK (timezone = 'Asia/Shanghai'),
  net_settled_credit_micros bigint NOT NULL DEFAULT 0 CHECK (net_settled_credit_micros >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_subject_id, fee_category, period_start)
);

CREATE TABLE kai_credit_fee_assessments (
  id uuid PRIMARY KEY,
  supplier_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  order_id uuid NOT NULL REFERENCES kai_credit_orders(id),
  schedule_id uuid NOT NULL,
  schedule_version text NOT NULL,
  period_id uuid NOT NULL REFERENCES kai_credit_supplier_fee_periods(id),
  period_start date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('settlement', 'reversal')),
  source_kind text NOT NULL CHECK (source_kind IN (
    'compute_settlement', 'renewal_settlement', 'compute_settlement_refund'
  )),
  source_id text NOT NULL CHECK (char_length(source_id) BETWEEN 8 AND 160),
  original_assessment_id uuid REFERENCES kai_credit_fee_assessments(id),
  idempotency_owner text NOT NULL CHECK (char_length(idempotency_owner) BETWEEN 3 AND 160),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 16 AND 120),
  payload_digest text NOT NULL CHECK (char_length(payload_digest) BETWEEN 16 AND 160),
  gross_credit_micros bigint NOT NULL CHECK (gross_credit_micros > 0),
  service_fee_credit_micros bigint NOT NULL CHECK (
    service_fee_credit_micros >= 0 AND service_fee_credit_micros <= gross_credit_micros
  ),
  net_credit_micros bigint NOT NULL CHECK (net_credit_micros >= 0),
  cumulative_before_micros bigint NOT NULL CHECK (cumulative_before_micros >= 0),
  cumulative_after_micros bigint NOT NULL CHECK (cumulative_after_micros >= 0),
  ledger_transaction_id uuid REFERENCES kai_credit_transactions(id),
  assessed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_kind, source_id),
  UNIQUE (idempotency_owner, idempotency_key),
  CHECK (net_credit_micros = gross_credit_micros - service_fee_credit_micros),
  CHECK (
    (kind = 'settlement' AND original_assessment_id IS NULL
      AND cumulative_after_micros = cumulative_before_micros + gross_credit_micros)
    OR (kind = 'reversal' AND original_assessment_id IS NOT NULL
      AND cumulative_before_micros = cumulative_after_micros + gross_credit_micros)
  ),
  CHECK (
    (kind = 'settlement' AND ledger_transaction_id IS NOT NULL)
    OR (kind = 'reversal' AND ((service_fee_credit_micros = 0) = (ledger_transaction_id IS NULL)))
  ),
  FOREIGN KEY (schedule_id, schedule_version)
    REFERENCES kai_credit_fee_schedules(id, version)
);
CREATE INDEX kai_credit_fee_assessments_supplier_period
  ON kai_credit_fee_assessments(supplier_subject_id, period_start, assessed_at DESC, id DESC);

CREATE TABLE kai_credit_fee_assessment_segments (
  id uuid PRIMARY KEY,
  assessment_id uuid NOT NULL REFERENCES kai_credit_fee_assessments(id),
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

CREATE TABLE kai_credit_fee_reversal_allocations (
  reversal_assessment_id uuid NOT NULL REFERENCES kai_credit_fee_assessments(id),
  original_segment_id uuid NOT NULL REFERENCES kai_credit_fee_assessment_segments(id),
  reversed_credit_micros bigint NOT NULL CHECK (reversed_credit_micros > 0),
  reversed_fee_credit_micros bigint NOT NULL CHECK (reversed_fee_credit_micros >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reversal_assessment_id, original_segment_id)
);

CREATE FUNCTION protect_kai_credit_fee_tier() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE schedule_status text;
BEGIN
  SELECT status INTO schedule_status FROM kai_credit_fee_schedules
    WHERE id = COALESCE(NEW.schedule_id, OLD.schedule_id) FOR UPDATE;
  IF schedule_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'active or retired kai credit fee tiers are immutable';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
CREATE TRIGGER kai_credit_fee_tiers_guard
  BEFORE INSERT OR UPDATE OR DELETE ON kai_credit_fee_tiers
  FOR EACH ROW EXECUTE FUNCTION protect_kai_credit_fee_tier();

CREATE FUNCTION validate_kai_credit_order_fee_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE schedule_status text;
DECLARE schedule_effective_from timestamptz;
DECLARE schedule_version_value text;
BEGIN
  IF NEW.policy_state = 'schedule_locked' THEN
    SELECT status, effective_from, version
      INTO schedule_status, schedule_effective_from, schedule_version_value
      FROM kai_credit_fee_schedules WHERE id = NEW.schedule_id FOR SHARE;
    IF schedule_status IS DISTINCT FROM 'active'
      OR schedule_version_value IS DISTINCT FROM NEW.schedule_version
      OR schedule_effective_from IS NULL OR schedule_effective_from > NEW.locked_at THEN
      RAISE EXCEPTION 'order fee policy requires an effective active schedule';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER kai_credit_order_fee_policies_validate
  BEFORE INSERT ON kai_credit_order_fee_policies
  FOR EACH ROW EXECUTE FUNCTION validate_kai_credit_order_fee_policy();
CREATE TRIGGER kai_credit_order_fee_policies_immutable
  BEFORE UPDATE OR DELETE ON kai_credit_order_fee_policies
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER kai_credit_fee_assessments_immutable
  BEFORE UPDATE OR DELETE ON kai_credit_fee_assessments
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER kai_credit_fee_assessment_segments_immutable
  BEFORE UPDATE OR DELETE ON kai_credit_fee_assessment_segments
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER kai_credit_fee_reversal_allocations_immutable
  BEFORE UPDATE OR DELETE ON kai_credit_fee_reversal_allocations
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER kai_credit_supplier_fee_periods_updated_at
  BEFORE UPDATE ON kai_credit_supplier_fee_periods FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION validate_kai_credit_fee_assessment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_supplier uuid;
DECLARE order_buyer uuid;
DECLARE order_status text;
DECLARE policy_state text;
DECLARE policy_schedule uuid;
DECLARE policy_version text;
DECLARE period_supplier uuid;
DECLARE period_date date;
DECLARE original_order uuid;
DECLARE original_supplier uuid;
DECLARE original_schedule uuid;
DECLARE original_period uuid;
DECLARE transaction_status text;
DECLARE transaction_scope text;
DECLARE transaction_reference_type text;
DECLARE transaction_reference_id text;
DECLARE entry_count integer;
DECLARE supplier_available_amount bigint;
DECLARE supplier_receivable_amount bigint;
DECLARE buyer_available_amount bigint;
DECLARE platform_revenue_amount bigint;
BEGIN
  SELECT supplier_subject_id, buyer_subject_id, status INTO order_supplier, order_buyer, order_status
    FROM kai_credit_orders WHERE id = NEW.order_id;
  SELECT p.policy_state, p.schedule_id, p.schedule_version
    INTO policy_state, policy_schedule, policy_version
    FROM kai_credit_order_fee_policies p WHERE p.order_id = NEW.order_id;
  SELECT supplier_subject_id, period_start INTO period_supplier, period_date
    FROM kai_credit_supplier_fee_periods WHERE id = NEW.period_id;
  IF order_supplier IS DISTINCT FROM NEW.supplier_subject_id OR order_status NOT IN ('accepted', 'closed')
    OR policy_state IS DISTINCT FROM 'schedule_locked'
    OR policy_schedule IS DISTINCT FROM NEW.schedule_id
    OR policy_version IS DISTINCT FROM NEW.schedule_version
    OR period_supplier IS DISTINCT FROM NEW.supplier_subject_id
    OR period_date IS DISTINCT FROM NEW.period_start THEN
    RAISE EXCEPTION 'fee assessment relation mismatch';
  END IF;
  IF (NEW.kind = 'settlement') <> (NEW.source_kind IN ('compute_settlement', 'renewal_settlement'))
    OR (NEW.kind = 'reversal') <> (NEW.source_kind = 'compute_settlement_refund') THEN
    RAISE EXCEPTION 'fee assessment source kind mismatch';
  END IF;
  IF NEW.kind = 'reversal' THEN
    SELECT order_id, supplier_subject_id, schedule_id, period_id
      INTO original_order, original_supplier, original_schedule, original_period
      FROM kai_credit_fee_assessments WHERE id = NEW.original_assessment_id AND kind = 'settlement';
    IF original_order IS DISTINCT FROM NEW.order_id OR original_supplier IS DISTINCT FROM NEW.supplier_subject_id
      OR original_schedule IS DISTINCT FROM NEW.schedule_id OR original_period IS DISTINCT FROM NEW.period_id THEN
      RAISE EXCEPTION 'fee reversal must match its original assessment';
    END IF;
  END IF;
  IF NEW.service_fee_credit_micros <= 0 OR NEW.net_credit_micros <= 0 OR NEW.ledger_transaction_id IS NULL THEN
    RAISE EXCEPTION 'fee ledger requires three non-zero legs';
  END IF;
  SELECT status, scope, reference_type, reference_id
    INTO transaction_status, transaction_scope, transaction_reference_type, transaction_reference_id
    FROM kai_credit_transactions WHERE id = NEW.ledger_transaction_id;
  SELECT count(*),
      COALESCE(sum(CASE WHEN a.subject_id = NEW.supplier_subject_id AND a.account_kind = 'available'
        THEN e.amount_micros ELSE 0 END), 0),
      COALESCE(sum(CASE WHEN a.subject_id = NEW.supplier_subject_id AND a.account_kind = 'supplier_receivable'
        THEN e.amount_micros ELSE 0 END), 0),
      COALESCE(sum(CASE WHEN a.subject_id = order_buyer AND a.account_kind = 'available'
        THEN e.amount_micros ELSE 0 END), 0),
      COALESCE(sum(CASE WHEN a.id = '00000000-0000-4000-8000-000000000103'
        THEN e.amount_micros ELSE 0 END), 0)
    INTO entry_count, supplier_available_amount, supplier_receivable_amount,
      buyer_available_amount, platform_revenue_amount
    FROM kai_credit_entries e JOIN kai_credit_accounts a ON a.id = e.account_id
    WHERE e.transaction_id = NEW.ledger_transaction_id;
  IF transaction_status IS DISTINCT FROM 'posted' OR entry_count <> 3
    OR transaction_reference_id IS DISTINCT FROM NEW.order_id::text THEN
    RAISE EXCEPTION 'invalid fee ledger transaction';
  END IF;
  IF NEW.kind = 'settlement' AND (
    transaction_scope IS DISTINCT FROM 'CREDIT_SUPPLIER_SETTLEMENT_WITH_FEE'
    OR transaction_reference_type IS DISTINCT FROM 'settlement'
    OR supplier_receivable_amount <> -NEW.gross_credit_micros
    OR supplier_available_amount <> NEW.net_credit_micros
    OR platform_revenue_amount <> NEW.service_fee_credit_micros
    OR buyer_available_amount <> 0
  ) THEN RAISE EXCEPTION 'invalid settlement fee ledger legs'; END IF;
  IF NEW.kind = 'reversal' AND (
    transaction_scope IS DISTINCT FROM 'CREDIT_SETTLEMENT_REFUND_WITH_FEE_REVERSAL'
    OR transaction_reference_type IS DISTINCT FROM 'service_fee_reversal'
    OR supplier_receivable_amount <> 0
    OR supplier_available_amount <> -NEW.net_credit_micros
    OR platform_revenue_amount <> -NEW.service_fee_credit_micros
    OR buyer_available_amount <> NEW.gross_credit_micros
  ) THEN RAISE EXCEPTION 'invalid fee reversal ledger legs'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER kai_credit_fee_assessments_validate
  BEFORE INSERT ON kai_credit_fee_assessments
  FOR EACH ROW EXECUTE FUNCTION validate_kai_credit_fee_assessment();

CREATE FUNCTION validate_kai_credit_fee_reversal_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reversal_original uuid;
DECLARE segment_assessment uuid;
DECLARE segment_volume bigint;
DECLARE segment_fee bigint;
DECLARE already_volume bigint;
DECLARE already_fee bigint;
BEGIN
  SELECT original_assessment_id INTO reversal_original FROM kai_credit_fee_assessments
    WHERE id = NEW.reversal_assessment_id AND kind = 'reversal';
  SELECT assessment_id, settled_credit_micros, service_fee_credit_micros
    INTO segment_assessment, segment_volume, segment_fee
    FROM kai_credit_fee_assessment_segments WHERE id = NEW.original_segment_id FOR UPDATE;
  SELECT COALESCE(sum(reversed_credit_micros), 0), COALESCE(sum(reversed_fee_credit_micros), 0)
    INTO already_volume, already_fee FROM kai_credit_fee_reversal_allocations
    WHERE original_segment_id = NEW.original_segment_id;
  IF reversal_original IS NULL OR segment_assessment IS DISTINCT FROM reversal_original
    OR already_volume + NEW.reversed_credit_micros > segment_volume
    OR already_fee + NEW.reversed_fee_credit_micros > segment_fee THEN
    RAISE EXCEPTION 'fee reversal allocation exceeds original segment';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER kai_credit_fee_reversal_allocations_validate
  BEFORE INSERT ON kai_credit_fee_reversal_allocations
  FOR EACH ROW EXECUTE FUNCTION validate_kai_credit_fee_reversal_allocation();

CREATE FUNCTION require_balanced_kai_credit_fee_segments() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE assessment_kind text;
DECLARE assessment_gross bigint;
DECLARE assessment_fee bigint;
DECLARE segment_gross numeric;
DECLARE segment_fee numeric;
DECLARE allocation_gross numeric;
DECLARE allocation_fee numeric;
BEGIN
  SELECT kind, gross_credit_micros, service_fee_credit_micros
    INTO assessment_kind, assessment_gross, assessment_fee
    FROM kai_credit_fee_assessments WHERE id = NEW.assessment_id;
  SELECT COALESCE(sum(settled_credit_micros), 0), COALESCE(sum(service_fee_credit_micros), 0)
    INTO segment_gross, segment_fee FROM kai_credit_fee_assessment_segments
    WHERE assessment_id = NEW.assessment_id;
  IF segment_gross <> assessment_gross OR segment_fee <> assessment_fee THEN
    RAISE EXCEPTION 'fee assessment segments do not balance';
  END IF;
  IF assessment_kind = 'reversal' THEN
    SELECT COALESCE(sum(reversed_credit_micros), 0), COALESCE(sum(reversed_fee_credit_micros), 0)
      INTO allocation_gross, allocation_fee FROM kai_credit_fee_reversal_allocations
      WHERE reversal_assessment_id = NEW.assessment_id;
    IF allocation_gross <> assessment_gross OR allocation_fee <> assessment_fee THEN
      RAISE EXCEPTION 'fee reversal allocations do not balance';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER kai_credit_fee_segments_balance
  AFTER INSERT ON kai_credit_fee_assessment_segments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_balanced_kai_credit_fee_segments();

CREATE FUNCTION protect_kai_credit_fee_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tier_count integer;
DECLARE invalid_tier_count integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'draft' THEN
      DELETE FROM kai_credit_fee_tiers WHERE schedule_id = OLD.id;
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'active or retired kai credit fee schedules cannot be deleted';
  END IF;
  IF NEW.id <> OLD.id OR NEW.version <> OLD.version OR NEW.fee_category <> OLD.fee_category
    OR NEW.currency <> OLD.currency OR NEW.timezone <> OLD.timezone
    OR NEW.rounding_model <> OLD.rounding_model OR NEW.created_by_user_id <> OLD.created_by_user_id
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'kai credit fee schedule identity is immutable';
  END IF;
  IF OLD.status = 'draft' AND NEW.status <> 'active' THEN
    RAISE EXCEPTION 'draft kai credit fee schedule can only be activated';
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'active' THEN
    SELECT count(*) INTO tier_count FROM kai_credit_fee_tiers WHERE schedule_id = OLD.id;
    SELECT count(*) INTO invalid_tier_count FROM (
      SELECT ordinal, lower_bound_micros, upper_bound_micros, rate_bps,
        lag(upper_bound_micros) OVER (ORDER BY ordinal) AS previous_upper,
        lag(rate_bps) OVER (ORDER BY ordinal) AS previous_rate,
        row_number() OVER (ORDER BY ordinal) AS row_number,
        count(*) OVER () AS total_rows
      FROM kai_credit_fee_tiers WHERE schedule_id = OLD.id
    ) ordered
    WHERE ordinal <> row_number - 1
      OR (row_number = 1 AND lower_bound_micros <> 0)
      OR (row_number > 1 AND lower_bound_micros IS DISTINCT FROM previous_upper)
      OR (row_number < total_rows AND upper_bound_micros IS NULL)
      OR (row_number = total_rows AND upper_bound_micros IS NOT NULL)
      OR (previous_rate IS NOT NULL AND rate_bps > previous_rate);
    IF tier_count = 0 OR invalid_tier_count <> 0 THEN
      RAISE EXCEPTION 'kai credit fee tiers must be contiguous, open-ended and non-increasing';
    END IF;
  END IF;
  IF OLD.status = 'active' AND NEW.status <> 'retired' THEN
    RAISE EXCEPTION 'active kai credit fee schedule can only be retired';
  END IF;
  IF OLD.status = 'retired' THEN RAISE EXCEPTION 'retired kai credit fee schedule is immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER kai_credit_fee_schedules_guard
  BEFORE UPDATE OR DELETE ON kai_credit_fee_schedules
  FOR EACH ROW EXECUTE FUNCTION protect_kai_credit_fee_schedule();

CREATE FUNCTION protect_kai_credit_supplier_fee_period() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'kai credit fee periods cannot be deleted'; END IF;
  IF NEW.id <> OLD.id OR NEW.supplier_subject_id <> OLD.supplier_subject_id
    OR NEW.fee_category <> OLD.fee_category OR NEW.period_start <> OLD.period_start
    OR NEW.timezone <> OLD.timezone OR NEW.created_at <> OLD.created_at
    OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'invalid kai credit fee period mutation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER kai_credit_supplier_fee_periods_guard
  BEFORE UPDATE OR DELETE ON kai_credit_supplier_fee_periods
  FOR EACH ROW EXECUTE FUNCTION protect_kai_credit_supplier_fee_period();
