ALTER TABLE kai_credit_accounts
  DROP CONSTRAINT kai_credit_accounts_account_kind_check,
  ADD CONSTRAINT kai_credit_accounts_account_kind_check CHECK (account_kind IN (
    'available', 'reserved', 'supplier_receivable', 'supplier_earnings_available', 'payout_frozen',
    'platform_issuance', 'platform_clearing', 'platform_revenue'
  ));

ALTER TABLE kai_credit_accounts
  DROP CONSTRAINT kai_credit_accounts_kind_owner_check,
  ADD CONSTRAINT kai_credit_accounts_kind_owner_check CHECK (
    (owner_kind = 'subject' AND account_kind IN (
      'available', 'reserved', 'supplier_receivable', 'supplier_earnings_available', 'payout_frozen'
    ) AND allow_negative = false)
    OR (owner_kind = 'platform' AND account_kind IN ('platform_issuance', 'platform_clearing', 'platform_revenue'))
  );

-- Existing generic available balances are intentionally not reclassified:
-- they may contain top-ups or already-spent settlement proceeds. Operations
-- must reconcile any pre-cut-over supplier settlement separately.

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
BEGIN
  SELECT total_credit_micros, status, supplier_subject_id
    INTO order_total, order_status, order_supplier
    FROM kai_credit_orders WHERE id = NEW.order_id;
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
      COALESCE(sum(CASE WHEN a.subject_id = NEW.supplier_subject_id AND a.account_kind = 'supplier_receivable'
        THEN e.amount_micros ELSE 0 END), 0)
    INTO entry_count, supplier_earnings_amount, receivable_amount
    FROM kai_credit_entries e JOIN kai_credit_accounts a ON a.id = e.account_id
    WHERE e.transaction_id = NEW.settlement_transaction_id;
  IF order_status IS DISTINCT FROM 'closed' OR order_supplier IS DISTINCT FROM NEW.supplier_subject_id
    OR NEW.credit_micros <> order_total - refunded_total OR NEW.credit_micros <= 0
    OR acceptance_order IS DISTINCT FROM NEW.order_id
    OR NEW.available_at IS DISTINCT FROM acceptance_time + interval '7 days'
    OR reservation_status IS DISTINCT FROM 'captured'
    OR transaction_status IS DISTINCT FROM 'posted' OR transaction_scope IS DISTINCT FROM 'CREDIT_SUPPLIER_SETTLEMENT'
    OR entry_count <> 2 OR supplier_earnings_amount <> NEW.credit_micros
    OR receivable_amount <> -NEW.credit_micros THEN
    RAISE EXCEPTION 'invalid kai credit supplier settlement';
  END IF;
  RETURN NEW;
END;
$$;

-- Fee settlements and reversals must use the independently redeemable supplier
-- earnings account. Buyer refunds continue to return to the buyer's generic
-- available balance, which can be spent but cannot be redeemed.
CREATE OR REPLACE FUNCTION validate_kai_credit_fee_assessment() RETURNS trigger LANGUAGE plpgsql AS $$
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
DECLARE supplier_earnings_amount bigint;
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
      COALESCE(sum(CASE WHEN a.subject_id = NEW.supplier_subject_id
        AND a.account_kind = 'supplier_earnings_available' THEN e.amount_micros ELSE 0 END), 0),
      COALESCE(sum(CASE WHEN a.subject_id = NEW.supplier_subject_id AND a.account_kind = 'supplier_receivable'
        THEN e.amount_micros ELSE 0 END), 0),
      COALESCE(sum(CASE WHEN a.subject_id = order_buyer AND a.account_kind = 'available'
        THEN e.amount_micros ELSE 0 END), 0),
      COALESCE(sum(CASE WHEN a.id = '00000000-0000-4000-8000-000000000103'
        THEN e.amount_micros ELSE 0 END), 0)
    INTO entry_count, supplier_earnings_amount, supplier_receivable_amount,
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
    OR supplier_earnings_amount <> NEW.net_credit_micros
    OR platform_revenue_amount <> NEW.service_fee_credit_micros
    OR buyer_available_amount <> 0
  ) THEN RAISE EXCEPTION 'invalid settlement fee ledger legs'; END IF;
  IF NEW.kind = 'reversal' AND (
    transaction_scope IS DISTINCT FROM 'CREDIT_SETTLEMENT_REFUND_WITH_FEE_REVERSAL'
    OR transaction_reference_type IS DISTINCT FROM 'service_fee_reversal'
    OR supplier_receivable_amount <> 0
    OR supplier_earnings_amount <> -NEW.net_credit_micros
    OR platform_revenue_amount <> -NEW.service_fee_credit_micros
    OR buyer_available_amount <> NEW.gross_credit_micros
  ) THEN RAISE EXCEPTION 'invalid fee reversal ledger legs'; END IF;
  RETURN NEW;
END;
$$;
