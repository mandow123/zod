CREATE FUNCTION require_card_hour_cent_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  column_name text;
  raw_value text;
  credit_value bigint;
BEGIN
  FOREACH column_name IN ARRAY TG_ARGV LOOP
    raw_value := to_jsonb(NEW) ->> column_name;
    IF raw_value IS NULL THEN CONTINUE; END IF;
    -- Old rows may contain pre-contract precision. A status-only update must not
    -- deadlock that row; any attempt to change the monetary column must use cents.
    IF TG_OP = 'UPDATE' AND raw_value IS NOT DISTINCT FROM (to_jsonb(OLD) ->> column_name) THEN
      CONTINUE;
    END IF;
    credit_value := raw_value::bigint;
    IF credit_value % 10000 <> 0 THEN
      RAISE EXCEPTION '% must use 0.01 KAI card-hour increments', column_name;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE FUNCTION require_ledger_cent_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.amount_micros % 10000 <> 0 THEN
    RAISE EXCEPTION 'ledger entries must use 0.01 KAI card-hour increments';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE kai_credit_legacy_precision_audits (
  account_id uuid PRIMARY KEY REFERENCES kai_credit_accounts(id),
  balance_micros bigint NOT NULL,
  remainder_micros bigint NOT NULL CHECK (remainder_micros <> 0 AND abs(remainder_micros) < 10000),
  adjusted_balance_micros bigint NOT NULL CHECK (adjusted_balance_micros % 10000 = 0),
  adjustment_transaction_id uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'isolated' CHECK (status IN ('isolated', 'reconciled')),
  detected_at timestamptz NOT NULL DEFAULT now(),
  reconciled_at timestamptz
);

CREATE FUNCTION legacy_cent_uuid(value text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT (substr(md5(value),1,8)||'-'||substr(md5(value),9,4)||'-'||substr(md5(value),13,4)||'-'
    ||substr(md5(value),17,4)||'-'||substr(md5(value),21,12))::uuid
$$;

INSERT INTO kai_credit_legacy_precision_audits(
  account_id, balance_micros, remainder_micros, adjusted_balance_micros, adjustment_transaction_id
)
SELECT a.id, COALESCE(sum(e.amount_micros) FILTER (WHERE t.status = 'posted'), 0)::bigint,
  (COALESCE(sum(e.amount_micros) FILTER (WHERE t.status = 'posted'), 0) % 10000)::bigint,
  (COALESCE(sum(e.amount_micros) FILTER (WHERE t.status = 'posted'), 0)
    - COALESCE(sum(e.amount_micros) FILTER (WHERE t.status = 'posted'), 0) % 10000)::bigint,
  legacy_cent_uuid('0055:transaction:' || a.id::text)
FROM kai_credit_accounts a
LEFT JOIN kai_credit_entries e ON e.account_id = a.id
LEFT JOIN kai_credit_transactions t ON t.id = e.transaction_id
WHERE a.owner_kind = 'subject'
GROUP BY a.id
HAVING COALESCE(sum(e.amount_micros) FILTER (WHERE t.status = 'posted'), 0) % 10000 <> 0;

-- Reconcile every legacy subject balance explicitly. The two sub-cent entries
-- are the final pre-contract exception, preserved forever with an audit row;
-- all writes after this block are guarded at the database boundary.
INSERT INTO kai_credit_transactions(id,idempotency_owner,scope,idempotency_key,payload_digest,
  reference_type,reference_id,description,status)
SELECT adjustment_transaction_id,'migration:0055','legacy_precision_reconciliation',
  'legacy-cent:' || account_id::text, md5(account_id::text || ':' || balance_micros::text),
  'adjustment',account_id::text,'旧卡时尾差迁移至两位小数','pending'
FROM kai_credit_legacy_precision_audits;

INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo)
SELECT legacy_cent_uuid('0055:subject-entry:' || account_id::text),adjustment_transaction_id,
  account_id,-remainder_micros,'旧卡时尾差调整'
FROM kai_credit_legacy_precision_audits;

INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo)
SELECT legacy_cent_uuid('0055:clearing-entry:' || account_id::text),adjustment_transaction_id,
  '00000000-0000-4000-8000-000000000102'::uuid,remainder_micros,'旧卡时尾差迁移'
FROM kai_credit_legacy_precision_audits;

UPDATE kai_credit_transactions t SET status='posted',posted_at=now()
FROM kai_credit_legacy_precision_audits a WHERE t.id=a.adjustment_transaction_id;
UPDATE kai_credit_legacy_precision_audits SET status='reconciled',reconciled_at=now();
ALTER TABLE kai_credit_legacy_precision_audits ADD CONSTRAINT kai_credit_legacy_precision_adjustment_fk
  FOREIGN KEY (adjustment_transaction_id) REFERENCES kai_credit_transactions(id);

CREATE TRIGGER kai_credit_entries_cent_guard
BEFORE INSERT ON kai_credit_entries FOR EACH ROW EXECUTE FUNCTION require_ledger_cent_entry();

DROP FUNCTION legacy_cent_uuid(text);

CREATE TABLE kai_credit_legacy_value_audits (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_table text NOT NULL,
  record_id text NOT NULL,
  column_name text NOT NULL,
  original_micros bigint NOT NULL,
  normalized_micros bigint NOT NULL CHECK (normalized_micros % 10000 = 0),
  rounding_rule text NOT NULL CHECK (rounding_rule IN ('floor', 'half_up')),
  migrated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_table, record_id, column_name)
);

-- Normalize legacy values that are shown directly in account, recharge and
-- marketplace read models. The immutable audit versions are unlocked only for
-- this audited migration and immediately protected again.
INSERT INTO kai_credit_legacy_value_audits(source_table,record_id,column_name,original_micros,normalized_micros,rounding_rule)
SELECT 'kai_credit_topups',id::text,'credit_micros',credit_micros,
  (FLOOR(credit_micros::numeric / 10000) * 10000)::bigint,'floor'
FROM kai_credit_topups WHERE credit_micros % 10000 <> 0;
INSERT INTO kai_credit_legacy_value_audits(source_table,record_id,column_name,original_micros,normalized_micros,rounding_rule)
SELECT 'kai_credit_topups',id::text,'reversed_credit_micros',reversed_credit_micros,
  (FLOOR(reversed_credit_micros::numeric / 10000) * 10000)::bigint,'floor'
FROM kai_credit_topups WHERE reversed_credit_micros % 10000 <> 0;
UPDATE kai_credit_topups SET
  credit_micros=(FLOOR(credit_micros::numeric / 10000) * 10000)::bigint,
  reversed_credit_micros=(FLOOR(reversed_credit_micros::numeric / 10000) * 10000)::bigint
WHERE credit_micros % 10000 <> 0 OR reversed_credit_micros % 10000 <> 0;

INSERT INTO kai_credit_legacy_value_audits(source_table,record_id,column_name,original_micros,normalized_micros,rounding_rule)
SELECT 'credit_market_listings',id::text,'unit_credit_micros',unit_credit_micros,
  (FLOOR((unit_credit_micros::numeric + 5000) / 10000) * 10000)::bigint,'half_up'
FROM credit_market_listings WHERE unit_credit_micros % 10000 <> 0;
UPDATE credit_market_listings SET unit_credit_micros=
  (FLOOR((unit_credit_micros::numeric + 5000) / 10000) * 10000)::bigint
WHERE unit_credit_micros % 10000 <> 0;

INSERT INTO kai_credit_legacy_value_audits(source_table,record_id,column_name,original_micros,normalized_micros,rounding_rule)
SELECT 'offer_templates',id::text,'approved_unit_credit_micros',approved_unit_credit_micros,
  (FLOOR((approved_unit_credit_micros::numeric + 5000) / 10000) * 10000)::bigint,'half_up'
FROM offer_templates WHERE approved_unit_credit_micros % 10000 <> 0;
UPDATE offer_templates SET approved_unit_credit_micros=
  (FLOOR((approved_unit_credit_micros::numeric + 5000) / 10000) * 10000)::bigint
WHERE approved_unit_credit_micros % 10000 <> 0;

INSERT INTO kai_credit_legacy_value_audits(source_table,record_id,column_name,original_micros,normalized_micros,rounding_rule)
SELECT 'offer_audit_versions',id::text,'approved_unit_credit_micros',approved_unit_credit_micros,
  (FLOOR((approved_unit_credit_micros::numeric + 5000) / 10000) * 10000)::bigint,'half_up'
FROM offer_audit_versions WHERE approved_unit_credit_micros % 10000 <> 0;
ALTER TABLE offer_audit_versions DISABLE TRIGGER offer_audit_versions_immutable;
UPDATE offer_audit_versions SET approved_unit_credit_micros=
  (FLOOR((approved_unit_credit_micros::numeric + 5000) / 10000) * 10000)::bigint
WHERE approved_unit_credit_micros % 10000 <> 0;
ALTER TABLE offer_audit_versions ENABLE TRIGGER offer_audit_versions_immutable;

CREATE FUNCTION legacy_credit_half_up(value bigint) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT (FLOOR((value::numeric + 5000) / 10000) * 10000)::bigint
$$;
CREATE FUNCTION audit_legacy_credit_columns(source regclass, columns_to_audit text[])
RETURNS void LANGUAGE plpgsql AS $$
DECLARE column_name text;
BEGIN
  FOREACH column_name IN ARRAY columns_to_audit LOOP
    EXECUTE format(
      'INSERT INTO kai_credit_legacy_value_audits(source_table,record_id,column_name,original_micros,normalized_micros,rounding_rule)
       SELECT %L,id::text,%L,%I,legacy_credit_half_up(%I),''half_up'' FROM %s
       WHERE %I IS NOT NULL AND %I %% 10000 <> 0 ON CONFLICT DO NOTHING',
      source::text,column_name,column_name,column_name,source,column_name,column_name
    );
  END LOOP;
END;
$$;
CREATE FUNCTION sync_legacy_credit_audits(source regclass, columns_to_sync text[])
RETURNS void LANGUAGE plpgsql AS $$
DECLARE column_name text;
BEGIN
  FOREACH column_name IN ARRAY columns_to_sync LOOP
    EXECUTE format(
      'UPDATE kai_credit_legacy_value_audits a SET normalized_micros=t.%I
       FROM %s t WHERE a.source_table=%L AND a.column_name=%L AND a.record_id=t.id::text',
      column_name,source,source::text,column_name
    );
  END LOOP;
END;
$$;
SELECT sync_legacy_credit_audits('kai_credit_topups',ARRAY['credit_micros','reversed_credit_micros']);
SELECT sync_legacy_credit_audits('credit_market_listings',ARRAY['unit_credit_micros']);
SELECT sync_legacy_credit_audits('offer_templates',ARRAY['approved_unit_credit_micros']);
SELECT sync_legacy_credit_audits('offer_audit_versions',ARRAY['approved_unit_credit_micros']);

-- Every legacy commerce value that can still be read or settled is migrated,
-- not merely formatted. Immutable workflow triggers are paused only inside
-- this migration; all original and normalized values remain in the audit table.
SELECT audit_legacy_credit_columns('kai_credit_orders',ARRAY['unit_credit_micros','total_credit_micros']);
ALTER TABLE kai_credit_orders DROP CONSTRAINT kai_credit_orders_check1;
ALTER TABLE kai_credit_orders DISABLE TRIGGER USER;
UPDATE kai_credit_orders SET
  unit_credit_micros=legacy_credit_half_up(unit_credit_micros),
  total_credit_micros=(CEIL(CEIL(quantity * legacy_credit_half_up(unit_credit_micros))::numeric / 10000) * 10000)::bigint
WHERE unit_credit_micros % 10000 <> 0 OR total_credit_micros % 10000 <> 0;
ALTER TABLE kai_credit_orders ENABLE TRIGGER USER;
SELECT sync_legacy_credit_audits('kai_credit_orders',ARRAY['unit_credit_micros','total_credit_micros']);

SELECT audit_legacy_credit_columns('kai_credit_order_reservations',ARRAY['credit_micros']);
ALTER TABLE kai_credit_order_reservations DISABLE TRIGGER USER;
UPDATE kai_credit_order_reservations r SET credit_micros=o.total_credit_micros
FROM kai_credit_orders o WHERE o.id=r.order_id AND r.credit_micros IS DISTINCT FROM o.total_credit_micros;
ALTER TABLE kai_credit_order_reservations ENABLE TRIGGER USER;
SELECT sync_legacy_credit_audits('kai_credit_order_reservations',ARRAY['credit_micros']);

SELECT audit_legacy_credit_columns('physical_device_orders',
  ARRAY['unit_credit_micros','gross_credit_micros','service_fee_credit_micros','supplier_net_credit_micros']);
ALTER TABLE physical_device_orders DISABLE TRIGGER USER;
UPDATE physical_device_orders SET
  unit_credit_micros=legacy_credit_half_up(unit_credit_micros),
  gross_credit_micros=legacy_credit_half_up(unit_credit_micros) * quantity,
  service_fee_credit_micros=CASE WHEN service_fee_credit_micros IS NULL THEN NULL
    ELSE LEAST(legacy_credit_half_up(service_fee_credit_micros),legacy_credit_half_up(unit_credit_micros) * quantity) END,
  supplier_net_credit_micros=CASE WHEN supplier_net_credit_micros IS NULL THEN NULL
    ELSE legacy_credit_half_up(unit_credit_micros) * quantity
      - LEAST(legacy_credit_half_up(COALESCE(service_fee_credit_micros,0)),legacy_credit_half_up(unit_credit_micros) * quantity) END
WHERE unit_credit_micros % 10000 <> 0 OR gross_credit_micros % 10000 <> 0
  OR service_fee_credit_micros % 10000 <> 0 OR supplier_net_credit_micros % 10000 <> 0;
ALTER TABLE physical_device_orders ENABLE TRIGGER USER;
SELECT sync_legacy_credit_audits('physical_device_orders',
  ARRAY['unit_credit_micros','gross_credit_micros','service_fee_credit_micros','supplier_net_credit_micros']);

-- Outstanding compute and physical-device holds must equal the buyer reserved
-- account after their contractual values are normalized.  Each difference is
-- posted as a balanced, deterministic migration transaction against clearing,
-- so a subsequent real release/capture can never overdraw reserved.
INSERT INTO kai_credit_accounts(id,owner_kind,subject_id,code,account_kind,allow_negative)
SELECT (substr(md5('0055:reserved-account:'||h.subject_id::text),1,8)||'-'||substr(md5('0055:reserved-account:'||h.subject_id::text),9,4)||'-'
  ||substr(md5('0055:reserved-account:'||h.subject_id::text),13,4)||'-'||substr(md5('0055:reserved-account:'||h.subject_id::text),17,4)||'-'
  ||substr(md5('0055:reserved-account:'||h.subject_id::text),21,12))::uuid,
  'subject',h.subject_id,'subject:'||h.subject_id::text||':reserved','reserved',false
FROM (
  SELECT buyer_subject_id AS subject_id FROM kai_credit_order_reservations WHERE status IN ('active','secured')
  UNION SELECT buyer_subject_id FROM physical_device_orders WHERE status IN ('reserved','confirmed','shipping')
) h ON CONFLICT DO NOTHING;

CREATE TEMP TABLE legacy_0055_reserved_deltas ON COMMIT DROP AS
WITH held AS (
  SELECT subject_id,sum(amount_micros)::bigint AS amount_micros FROM (
    SELECT buyer_subject_id AS subject_id,credit_micros AS amount_micros
      FROM kai_credit_order_reservations WHERE status IN ('active','secured')
    UNION ALL
    SELECT buyer_subject_id,gross_credit_micros FROM physical_device_orders
      WHERE status IN ('reserved','confirmed','shipping')
  ) x GROUP BY subject_id
), balances AS (
  SELECT a.id AS account_id,a.subject_id,
    COALESCE(sum(e.amount_micros) FILTER (WHERE t.status='posted'),0)::bigint AS amount_micros
  FROM kai_credit_accounts a
  LEFT JOIN kai_credit_entries e ON e.account_id=a.id
  LEFT JOIN kai_credit_transactions t ON t.id=e.transaction_id
  WHERE a.owner_kind='subject' AND a.account_kind='reserved'
  GROUP BY a.id,a.subject_id
)
SELECT b.account_id,b.subject_id,(COALESCE(h.amount_micros,0)-b.amount_micros)::bigint AS delta_micros,
  (substr(md5('0055:reserved-workflow:'||b.subject_id::text),1,8)||'-'||substr(md5('0055:reserved-workflow:'||b.subject_id::text),9,4)||'-'
   ||substr(md5('0055:reserved-workflow:'||b.subject_id::text),13,4)||'-'||substr(md5('0055:reserved-workflow:'||b.subject_id::text),17,4)||'-'
   ||substr(md5('0055:reserved-workflow:'||b.subject_id::text),21,12))::uuid AS transaction_id
FROM balances b LEFT JOIN held h ON h.subject_id=b.subject_id
WHERE COALESCE(h.amount_micros,0)<>b.amount_micros;

INSERT INTO kai_credit_transactions(id,idempotency_owner,scope,idempotency_key,payload_digest,
  reference_type,reference_id,description,status)
SELECT transaction_id,'migration:0055','legacy_reserved_reconciliation','legacy-reserved:'||subject_id::text,
  md5(subject_id::text||':'||delta_micros::text),'adjustment',subject_id::text,
  '存量订单预留卡时两位小数对账','pending' FROM legacy_0055_reserved_deltas;
INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo)
SELECT (substr(md5('0055:reserved-entry:'||subject_id::text),1,8)||'-'||substr(md5('0055:reserved-entry:'||subject_id::text),9,4)||'-'
  ||substr(md5('0055:reserved-entry:'||subject_id::text),13,4)||'-'||substr(md5('0055:reserved-entry:'||subject_id::text),17,4)||'-'
  ||substr(md5('0055:reserved-entry:'||subject_id::text),21,12))::uuid,
  transaction_id,account_id,delta_micros,'存量订单预留卡时调整' FROM legacy_0055_reserved_deltas;
INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo)
SELECT (substr(md5('0055:reserved-clearing:'||subject_id::text),1,8)||'-'||substr(md5('0055:reserved-clearing:'||subject_id::text),9,4)||'-'
  ||substr(md5('0055:reserved-clearing:'||subject_id::text),13,4)||'-'||substr(md5('0055:reserved-clearing:'||subject_id::text),17,4)||'-'
  ||substr(md5('0055:reserved-clearing:'||subject_id::text),21,12))::uuid,
  transaction_id,'00000000-0000-4000-8000-000000000102'::uuid,-delta_micros,'存量订单预留卡时清算' FROM legacy_0055_reserved_deltas;
UPDATE kai_credit_transactions t SET status='posted',posted_at=now()
FROM legacy_0055_reserved_deltas d WHERE t.id=d.transaction_id;

SELECT audit_legacy_credit_columns('physical_device_supplier_settlements',
  ARRAY['gross_credit_micros','service_fee_credit_micros','net_credit_micros']);
ALTER TABLE physical_device_supplier_settlements DISABLE TRIGGER USER;
UPDATE physical_device_supplier_settlements s SET gross_credit_micros=o.gross_credit_micros,
  service_fee_credit_micros=COALESCE(o.service_fee_credit_micros,0),
  net_credit_micros=o.gross_credit_micros-COALESCE(o.service_fee_credit_micros,0)
FROM physical_device_orders o WHERE o.id=s.order_id AND (
  s.gross_credit_micros % 10000 <> 0 OR s.service_fee_credit_micros % 10000 <> 0 OR s.net_credit_micros % 10000 <> 0);
ALTER TABLE physical_device_supplier_settlements ENABLE TRIGGER USER;
SELECT sync_legacy_credit_audits('physical_device_supplier_settlements',
  ARRAY['gross_credit_micros','service_fee_credit_micros','net_credit_micros']);

SELECT audit_legacy_credit_columns('compute_fulfillment_acceptances',ARRAY['captured_credit_micros','refunded_credit_micros']);
ALTER TABLE compute_fulfillment_acceptances DISABLE TRIGGER USER;
UPDATE compute_fulfillment_acceptances a SET
  captured_credit_micros=LEAST(legacy_credit_half_up(a.captured_credit_micros),o.total_credit_micros),
  refunded_credit_micros=o.total_credit_micros-LEAST(legacy_credit_half_up(a.captured_credit_micros),o.total_credit_micros)
FROM kai_credit_orders o WHERE o.id=a.order_id AND (
  a.captured_credit_micros % 10000 <> 0 OR a.refunded_credit_micros % 10000 <> 0);
ALTER TABLE compute_fulfillment_acceptances ENABLE TRIGGER USER;
SELECT sync_legacy_credit_audits('compute_fulfillment_acceptances',ARRAY['captured_credit_micros','refunded_credit_micros']);

SELECT audit_legacy_credit_columns('compute_fulfillment_issue_decisions',
  ARRAY['metered_credit_micros','remedy_refund_credit_micros','provider_credit_micros','buyer_refund_credit_micros']);
ALTER TABLE compute_fulfillment_issue_decisions DISABLE TRIGGER USER;
UPDATE compute_fulfillment_issue_decisions d SET
  provider_credit_micros=CASE WHEN d.outcome='full_refund' THEN 0 ELSE
    LEAST(GREATEST(10000,legacy_credit_half_up(d.provider_credit_micros)),o.total_credit_micros) END,
  remedy_refund_credit_micros=CASE WHEN d.outcome='reject_refund' THEN 0
    ELSE legacy_credit_half_up(d.remedy_refund_credit_micros) END,
  metered_credit_micros=(CASE WHEN d.outcome='full_refund' THEN 0 ELSE
    LEAST(GREATEST(10000,legacy_credit_half_up(d.provider_credit_micros)),o.total_credit_micros) END)
    + (CASE WHEN d.outcome='reject_refund' THEN 0 ELSE legacy_credit_half_up(d.remedy_refund_credit_micros) END),
  buyer_refund_credit_micros=o.total_credit_micros-(CASE WHEN d.outcome='full_refund' THEN 0 ELSE
    LEAST(GREATEST(10000,legacy_credit_half_up(d.provider_credit_micros)),o.total_credit_micros) END)
FROM kai_credit_orders o WHERE o.id=d.order_id AND (d.metered_credit_micros % 10000 <> 0
  OR d.remedy_refund_credit_micros % 10000 <> 0 OR d.provider_credit_micros % 10000 <> 0
  OR d.buyer_refund_credit_micros % 10000 <> 0);
ALTER TABLE compute_fulfillment_issue_decisions ENABLE TRIGGER USER;
SELECT sync_legacy_credit_audits('compute_fulfillment_issue_decisions',
  ARRAY['metered_credit_micros','remedy_refund_credit_micros','provider_credit_micros','buyer_refund_credit_micros']);

SELECT audit_legacy_credit_columns('compute_fulfillment_supplier_settlements',ARRAY['credit_micros','service_fee_credit_micros']);
ALTER TABLE compute_fulfillment_supplier_settlements DISABLE TRIGGER USER;
UPDATE compute_fulfillment_supplier_settlements SET
  credit_micros=legacy_credit_half_up(credit_micros),
  service_fee_credit_micros=LEAST(legacy_credit_half_up(service_fee_credit_micros),legacy_credit_half_up(credit_micros))
WHERE credit_micros % 10000 <> 0 OR service_fee_credit_micros % 10000 <> 0;
ALTER TABLE compute_fulfillment_supplier_settlements ENABLE TRIGGER USER;
SELECT sync_legacy_credit_audits('compute_fulfillment_supplier_settlements',ARRAY['credit_micros','service_fee_credit_micros']);

SELECT audit_legacy_credit_columns('kai_credit_supplier_fee_periods',ARRAY['net_settled_credit_micros']);
ALTER TABLE kai_credit_supplier_fee_periods DISABLE TRIGGER USER;
UPDATE kai_credit_supplier_fee_periods SET net_settled_credit_micros=legacy_credit_half_up(net_settled_credit_micros)
WHERE net_settled_credit_micros % 10000 <> 0;
ALTER TABLE kai_credit_supplier_fee_periods ENABLE TRIGGER USER;
SELECT sync_legacy_credit_audits('kai_credit_supplier_fee_periods',ARRAY['net_settled_credit_micros']);

SELECT audit_legacy_credit_columns('kai_credit_fee_assessments',
  ARRAY['gross_credit_micros','service_fee_credit_micros','net_credit_micros','cumulative_before_micros','cumulative_after_micros']);
ALTER TABLE kai_credit_fee_assessments DISABLE TRIGGER USER;
UPDATE kai_credit_fee_assessments SET gross_credit_micros=legacy_credit_half_up(gross_credit_micros),
  service_fee_credit_micros=LEAST(legacy_credit_half_up(service_fee_credit_micros),legacy_credit_half_up(gross_credit_micros)),
  net_credit_micros=legacy_credit_half_up(gross_credit_micros)
    - LEAST(legacy_credit_half_up(service_fee_credit_micros),legacy_credit_half_up(gross_credit_micros)),
  cumulative_before_micros=CASE WHEN kind='settlement' THEN legacy_credit_half_up(cumulative_before_micros)
    ELSE legacy_credit_half_up(cumulative_after_micros)+legacy_credit_half_up(gross_credit_micros) END,
  cumulative_after_micros=CASE WHEN kind='settlement' THEN legacy_credit_half_up(cumulative_before_micros)
    +legacy_credit_half_up(gross_credit_micros) ELSE legacy_credit_half_up(cumulative_after_micros) END
WHERE gross_credit_micros % 10000 <> 0 OR service_fee_credit_micros % 10000 <> 0
  OR net_credit_micros % 10000 <> 0 OR cumulative_before_micros % 10000 <> 0 OR cumulative_after_micros % 10000 <> 0;
ALTER TABLE kai_credit_fee_assessments ENABLE TRIGGER USER;
SELECT sync_legacy_credit_audits('kai_credit_fee_assessments',
  ARRAY['gross_credit_micros','service_fee_credit_micros','net_credit_micros','cumulative_before_micros','cumulative_after_micros']);

SELECT audit_legacy_credit_columns('kai_credit_fee_assessment_segments',
  ARRAY['lower_bound_micros','upper_bound_micros','settled_credit_micros','service_fee_credit_micros']);
ALTER TABLE kai_credit_fee_assessment_segments DISABLE TRIGGER USER;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM kai_credit_fee_assessments a JOIN (
      SELECT assessment_id,count(*) AS segment_count,
        sum(GREATEST(10000,legacy_credit_half_up(settled_credit_micros))) AS rounded_gross,
        sum(legacy_credit_half_up(service_fee_credit_micros)) AS rounded_fee,
        max(GREATEST(10000,legacy_credit_half_up(settled_credit_micros))) AS largest_gross,
        max(legacy_credit_half_up(service_fee_credit_micros)) AS largest_fee
      FROM kai_credit_fee_assessment_segments GROUP BY assessment_id
    ) s ON s.assessment_id=a.id
    WHERE a.gross_credit_micros < s.segment_count*10000
      OR a.gross_credit_micros-(s.rounded_gross-s.largest_gross) < 10000
      OR a.service_fee_credit_micros-(s.rounded_fee-s.largest_fee) < 0
  ) THEN RAISE EXCEPTION 'legacy fee segments cannot be represented at 0.01 KAI card-hour precision'; END IF;
END $$;
WITH normalized AS (
  SELECT s.id,a.gross_credit_micros,a.service_fee_credit_micros AS assessment_fee,
    row_number() OVER (PARTITION BY s.assessment_id
      ORDER BY s.settled_credit_micros DESC,s.ordinal DESC,s.id DESC) AS gross_residual_row,
    row_number() OVER (PARTITION BY s.assessment_id
      ORDER BY s.service_fee_credit_micros DESC,s.ordinal DESC,s.id DESC) AS fee_residual_row,
    GREATEST(10000,legacy_credit_half_up(s.settled_credit_micros)) AS rounded_gross,
    legacy_credit_half_up(s.service_fee_credit_micros) AS rounded_fee,
    sum(GREATEST(10000,legacy_credit_half_up(s.settled_credit_micros))) OVER (PARTITION BY s.assessment_id) AS gross_sum,
    sum(legacy_credit_half_up(s.service_fee_credit_micros)) OVER (PARTITION BY s.assessment_id) AS fee_sum
  FROM kai_credit_fee_assessment_segments s JOIN kai_credit_fee_assessments a ON a.id=s.assessment_id
)
UPDATE kai_credit_fee_assessment_segments s SET
  lower_bound_micros=legacy_credit_half_up(s.lower_bound_micros),
  upper_bound_micros=CASE WHEN s.upper_bound_micros IS NULL THEN NULL ELSE legacy_credit_half_up(s.upper_bound_micros) END,
  settled_credit_micros=n.rounded_gross+CASE WHEN n.gross_residual_row=1 THEN n.gross_credit_micros-n.gross_sum ELSE 0 END,
  service_fee_credit_micros=n.rounded_fee+CASE WHEN n.fee_residual_row=1 THEN n.assessment_fee-n.fee_sum ELSE 0 END
FROM normalized n WHERE n.id=s.id AND (s.lower_bound_micros%10000<>0 OR s.upper_bound_micros%10000<>0
  OR s.settled_credit_micros%10000<>0 OR s.service_fee_credit_micros%10000<>0);
ALTER TABLE kai_credit_fee_assessment_segments ENABLE TRIGGER USER;
SELECT sync_legacy_credit_audits('kai_credit_fee_assessment_segments',
  ARRAY['lower_bound_micros','upper_bound_micros','settled_credit_micros','service_fee_credit_micros']);

-- Reversal allocations use a composite identity, so preserve that identity in
-- the audit key and then redistribute the final cent to keep each assessment
-- exactly equal to its normalized parent.
INSERT INTO kai_credit_legacy_value_audits(source_table,record_id,column_name,original_micros,normalized_micros,rounding_rule)
SELECT 'kai_credit_fee_reversal_allocations',reversal_assessment_id::text||':'||original_segment_id::text,
  'reversed_credit_micros',reversed_credit_micros,legacy_credit_half_up(reversed_credit_micros),'half_up'
FROM kai_credit_fee_reversal_allocations WHERE reversed_credit_micros%10000<>0 ON CONFLICT DO NOTHING;
INSERT INTO kai_credit_legacy_value_audits(source_table,record_id,column_name,original_micros,normalized_micros,rounding_rule)
SELECT 'kai_credit_fee_reversal_allocations',reversal_assessment_id::text||':'||original_segment_id::text,
  'reversed_fee_credit_micros',reversed_fee_credit_micros,legacy_credit_half_up(reversed_fee_credit_micros),'half_up'
FROM kai_credit_fee_reversal_allocations WHERE reversed_fee_credit_micros%10000<>0 ON CONFLICT DO NOTHING;
ALTER TABLE kai_credit_fee_reversal_allocations DISABLE TRIGGER USER;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM kai_credit_fee_assessments a JOIN (
      SELECT reversal_assessment_id,count(*) AS allocation_count,
        sum(GREATEST(10000,legacy_credit_half_up(reversed_credit_micros))) AS rounded_gross,
        sum(legacy_credit_half_up(reversed_fee_credit_micros)) AS rounded_fee,
        max(GREATEST(10000,legacy_credit_half_up(reversed_credit_micros))) AS largest_gross,
        max(legacy_credit_half_up(reversed_fee_credit_micros)) AS largest_fee
      FROM kai_credit_fee_reversal_allocations GROUP BY reversal_assessment_id
    ) r ON r.reversal_assessment_id=a.id
    WHERE a.gross_credit_micros < r.allocation_count*10000
      OR a.gross_credit_micros-(r.rounded_gross-r.largest_gross) < 10000
      OR a.service_fee_credit_micros-(r.rounded_fee-r.largest_fee) < 0
  ) THEN RAISE EXCEPTION 'legacy fee reversal allocations cannot be represented at 0.01 KAI card-hour precision'; END IF;
END $$;
WITH normalized AS (
  SELECT r.reversal_assessment_id,r.original_segment_id,a.gross_credit_micros,
    a.service_fee_credit_micros AS assessment_fee,
    row_number() OVER (PARTITION BY r.reversal_assessment_id
      ORDER BY r.reversed_credit_micros DESC,r.original_segment_id DESC) AS gross_residual_row,
    row_number() OVER (PARTITION BY r.reversal_assessment_id
      ORDER BY r.reversed_fee_credit_micros DESC,r.original_segment_id DESC) AS fee_residual_row,
    GREATEST(10000,legacy_credit_half_up(r.reversed_credit_micros)) AS rounded_gross,
    legacy_credit_half_up(r.reversed_fee_credit_micros) AS rounded_fee,
    sum(GREATEST(10000,legacy_credit_half_up(r.reversed_credit_micros))) OVER (PARTITION BY r.reversal_assessment_id) AS gross_sum,
    sum(legacy_credit_half_up(r.reversed_fee_credit_micros)) OVER (PARTITION BY r.reversal_assessment_id) AS fee_sum
  FROM kai_credit_fee_reversal_allocations r JOIN kai_credit_fee_assessments a ON a.id=r.reversal_assessment_id
)
UPDATE kai_credit_fee_reversal_allocations r SET
  reversed_credit_micros=n.rounded_gross+CASE WHEN n.gross_residual_row=1 THEN n.gross_credit_micros-n.gross_sum ELSE 0 END,
  reversed_fee_credit_micros=n.rounded_fee+CASE WHEN n.fee_residual_row=1 THEN n.assessment_fee-n.fee_sum ELSE 0 END
FROM normalized n WHERE n.reversal_assessment_id=r.reversal_assessment_id
  AND n.original_segment_id=r.original_segment_id
  AND (r.reversed_credit_micros%10000<>0 OR r.reversed_fee_credit_micros%10000<>0);
ALTER TABLE kai_credit_fee_reversal_allocations ENABLE TRIGGER USER;
UPDATE kai_credit_legacy_value_audits a SET normalized_micros=r.reversed_credit_micros
FROM kai_credit_fee_reversal_allocations r WHERE a.source_table='kai_credit_fee_reversal_allocations'
  AND a.column_name='reversed_credit_micros'
  AND a.record_id=r.reversal_assessment_id::text||':'||r.original_segment_id::text;
UPDATE kai_credit_legacy_value_audits a SET normalized_micros=r.reversed_fee_credit_micros
FROM kai_credit_fee_reversal_allocations r WHERE a.source_table='kai_credit_fee_reversal_allocations'
  AND a.column_name='reversed_fee_credit_micros'
  AND a.record_id=r.reversal_assessment_id::text||':'||r.original_segment_id::text;

SELECT audit_legacy_credit_columns('physical_device_fee_assessments',
  ARRAY['gross_credit_micros','service_fee_credit_micros','net_credit_micros','cumulative_before_micros','cumulative_after_micros']);
ALTER TABLE physical_device_fee_assessments DISABLE TRIGGER USER;
UPDATE physical_device_fee_assessments SET
  gross_credit_micros=legacy_credit_half_up(gross_credit_micros),
  service_fee_credit_micros=LEAST(legacy_credit_half_up(service_fee_credit_micros),legacy_credit_half_up(gross_credit_micros)-10000),
  net_credit_micros=legacy_credit_half_up(gross_credit_micros)
    -LEAST(legacy_credit_half_up(service_fee_credit_micros),legacy_credit_half_up(gross_credit_micros)-10000),
  cumulative_before_micros=legacy_credit_half_up(cumulative_before_micros),
  cumulative_after_micros=legacy_credit_half_up(cumulative_before_micros)+legacy_credit_half_up(gross_credit_micros)
WHERE gross_credit_micros%10000<>0 OR service_fee_credit_micros%10000<>0 OR net_credit_micros%10000<>0
  OR cumulative_before_micros%10000<>0 OR cumulative_after_micros%10000<>0;
ALTER TABLE physical_device_fee_assessments ENABLE TRIGGER USER;
SELECT sync_legacy_credit_audits('physical_device_fee_assessments',
  ARRAY['gross_credit_micros','service_fee_credit_micros','net_credit_micros','cumulative_before_micros','cumulative_after_micros']);

SELECT audit_legacy_credit_columns('physical_device_fee_assessment_segments',
  ARRAY['lower_bound_micros','upper_bound_micros','settled_credit_micros','service_fee_credit_micros']);
ALTER TABLE physical_device_fee_assessment_segments DISABLE TRIGGER USER;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM physical_device_fee_assessments a JOIN (
      SELECT assessment_id,count(*) AS segment_count,
        sum(GREATEST(10000,legacy_credit_half_up(settled_credit_micros))) AS rounded_gross,
        sum(legacy_credit_half_up(service_fee_credit_micros)) AS rounded_fee,
        max(GREATEST(10000,legacy_credit_half_up(settled_credit_micros))) AS largest_gross,
        max(legacy_credit_half_up(service_fee_credit_micros)) AS largest_fee
      FROM physical_device_fee_assessment_segments GROUP BY assessment_id
    ) s ON s.assessment_id=a.id
    WHERE a.gross_credit_micros < s.segment_count*10000
      OR a.gross_credit_micros-(s.rounded_gross-s.largest_gross) < 10000
      OR a.service_fee_credit_micros-(s.rounded_fee-s.largest_fee) < 0
  ) THEN RAISE EXCEPTION 'legacy physical fee segments cannot be represented at 0.01 KAI card-hour precision'; END IF;
END $$;
WITH normalized AS (
  SELECT s.id,a.gross_credit_micros,a.service_fee_credit_micros AS assessment_fee,
    row_number() OVER (PARTITION BY s.assessment_id
      ORDER BY s.settled_credit_micros DESC,s.ordinal DESC,s.id DESC) AS gross_residual_row,
    row_number() OVER (PARTITION BY s.assessment_id
      ORDER BY s.service_fee_credit_micros DESC,s.ordinal DESC,s.id DESC) AS fee_residual_row,
    GREATEST(10000,legacy_credit_half_up(s.settled_credit_micros)) AS rounded_gross,
    legacy_credit_half_up(s.service_fee_credit_micros) AS rounded_fee,
    sum(GREATEST(10000,legacy_credit_half_up(s.settled_credit_micros))) OVER (PARTITION BY s.assessment_id) AS gross_sum,
    sum(legacy_credit_half_up(s.service_fee_credit_micros)) OVER (PARTITION BY s.assessment_id) AS fee_sum
  FROM physical_device_fee_assessment_segments s JOIN physical_device_fee_assessments a ON a.id=s.assessment_id
)
UPDATE physical_device_fee_assessment_segments s SET
  lower_bound_micros=legacy_credit_half_up(s.lower_bound_micros),
  upper_bound_micros=CASE WHEN s.upper_bound_micros IS NULL THEN NULL ELSE legacy_credit_half_up(s.upper_bound_micros) END,
  settled_credit_micros=n.rounded_gross+CASE WHEN n.gross_residual_row=1 THEN n.gross_credit_micros-n.gross_sum ELSE 0 END,
  service_fee_credit_micros=n.rounded_fee+CASE WHEN n.fee_residual_row=1 THEN n.assessment_fee-n.fee_sum ELSE 0 END
FROM normalized n WHERE n.id=s.id AND (s.lower_bound_micros%10000<>0 OR s.upper_bound_micros%10000<>0
  OR s.settled_credit_micros%10000<>0 OR s.service_fee_credit_micros%10000<>0);
ALTER TABLE physical_device_fee_assessment_segments ENABLE TRIGGER USER;
SELECT sync_legacy_credit_audits('physical_device_fee_assessment_segments',
  ARRAY['lower_bound_micros','upper_bound_micros','settled_credit_micros','service_fee_credit_micros']);

SELECT audit_legacy_credit_columns('kai_credit_order_mutual_refunds',ARRAY['credit_micros']);
ALTER TABLE kai_credit_order_mutual_refunds DISABLE TRIGGER USER;
UPDATE kai_credit_order_mutual_refunds r SET credit_micros=o.total_credit_micros
FROM kai_credit_orders o WHERE o.id=r.order_id AND r.credit_micros IS DISTINCT FROM o.total_credit_micros;
ALTER TABLE kai_credit_order_mutual_refunds ENABLE TRIGGER USER;
SELECT sync_legacy_credit_audits('kai_credit_order_mutual_refunds',ARRAY['credit_micros']);

SELECT audit_legacy_credit_columns('kai_credit_order_post_acceptance_refunds',ARRAY['credit_micros']);
ALTER TABLE kai_credit_order_post_acceptance_refunds DISABLE TRIGGER USER;
UPDATE kai_credit_order_post_acceptance_refunds r SET
  credit_micros=LEAST(o.total_credit_micros,GREATEST(10000,legacy_credit_half_up(r.credit_micros)))
FROM kai_credit_orders o WHERE o.id=r.order_id AND r.credit_micros%10000<>0;
ALTER TABLE kai_credit_order_post_acceptance_refunds ENABLE TRIGGER USER;
SELECT sync_legacy_credit_audits('kai_credit_order_post_acceptance_refunds',ARRAY['credit_micros']);

SELECT audit_legacy_credit_columns('kai_credit_order_dispute_decisions',ARRAY['credit_micros']);
ALTER TABLE kai_credit_order_dispute_decisions DISABLE TRIGGER USER;
UPDATE kai_credit_order_dispute_decisions d SET credit_micros=CASE WHEN d.outcome='full_refund' THEN o.total_credit_micros ELSE 0 END
FROM kai_credit_orders o WHERE o.id=d.order_id AND d.credit_micros%10000<>0;
ALTER TABLE kai_credit_order_dispute_decisions ENABLE TRIGGER USER;
SELECT sync_legacy_credit_audits('kai_credit_order_dispute_decisions',ARRAY['credit_micros']);

SELECT audit_legacy_credit_columns('kai_credit_post_acceptance_refund_decisions',ARRAY['credit_micros']);
ALTER TABLE kai_credit_post_acceptance_refund_decisions DISABLE TRIGGER USER;
UPDATE kai_credit_post_acceptance_refund_decisions d SET credit_micros=CASE WHEN d.outcome='reject_refund' THEN 0 ELSE r.credit_micros END
FROM kai_credit_order_post_acceptance_refunds r WHERE r.id=d.refund_id AND d.credit_micros%10000<>0;
ALTER TABLE kai_credit_post_acceptance_refund_decisions ENABLE TRIGGER USER;
SELECT sync_legacy_credit_audits('kai_credit_post_acceptance_refund_decisions',ARRAY['credit_micros']);

SELECT audit_legacy_credit_columns('kai_credit_supplier_settlements',ARRAY['credit_micros','service_fee_credit_micros']);
ALTER TABLE kai_credit_supplier_settlements DISABLE TRIGGER USER;
UPDATE kai_credit_supplier_settlements SET credit_micros=legacy_credit_half_up(credit_micros),
  service_fee_credit_micros=LEAST(legacy_credit_half_up(service_fee_credit_micros),legacy_credit_half_up(credit_micros))
WHERE credit_micros%10000<>0 OR service_fee_credit_micros%10000<>0;
ALTER TABLE kai_credit_supplier_settlements ENABLE TRIGGER USER;
SELECT sync_legacy_credit_audits('kai_credit_supplier_settlements',ARRAY['credit_micros','service_fee_credit_micros']);

SELECT audit_legacy_credit_columns('kai_credit_payout_requests',ARRAY['credit_micros','available_before_micros',
  'available_after_micros','frozen_before_micros','frozen_after_micros','resolution_available_before_micros',
  'resolution_available_after_micros','resolution_frozen_before_micros','resolution_frozen_after_micros']);
ALTER TABLE kai_credit_payout_requests DISABLE TRIGGER USER;
UPDATE kai_credit_payout_requests SET
  credit_micros=GREATEST(10000,legacy_credit_half_up(credit_micros)),
  cny_micros=(GREATEST(10000,legacy_credit_half_up(credit_micros))*conversion_cny_micros_per_credit+500000)/1000000,
  payment_amount_cents=(((GREATEST(10000,legacy_credit_half_up(credit_micros))*conversion_cny_micros_per_credit+500000)/1000000)+5000)/10000,
  company_payment_amount_cents=CASE WHEN company_payment_amount_cents IS NULL THEN NULL ELSE
    (((GREATEST(10000,legacy_credit_half_up(credit_micros))*conversion_cny_micros_per_credit+500000)/1000000)+5000)/10000 END,
  available_before_micros=GREATEST(GREATEST(10000,legacy_credit_half_up(credit_micros)),legacy_credit_half_up(available_before_micros)),
  available_after_micros=GREATEST(GREATEST(10000,legacy_credit_half_up(credit_micros)),legacy_credit_half_up(available_before_micros))
    -GREATEST(10000,legacy_credit_half_up(credit_micros)),
  frozen_before_micros=legacy_credit_half_up(frozen_before_micros),
  frozen_after_micros=legacy_credit_half_up(frozen_before_micros)+GREATEST(10000,legacy_credit_half_up(credit_micros)),
  resolution_available_before_micros=CASE WHEN resolution_available_before_micros IS NULL THEN NULL
    ELSE legacy_credit_half_up(resolution_available_before_micros) END,
  resolution_available_after_micros=CASE WHEN resolution_available_before_micros IS NULL THEN NULL
    ELSE legacy_credit_half_up(resolution_available_before_micros)
      +CASE WHEN status='succeeded' THEN 0 ELSE GREATEST(10000,legacy_credit_half_up(credit_micros)) END END,
  resolution_frozen_before_micros=CASE WHEN resolution_frozen_before_micros IS NULL THEN NULL
    ELSE GREATEST(GREATEST(10000,legacy_credit_half_up(credit_micros)),legacy_credit_half_up(resolution_frozen_before_micros)) END,
  resolution_frozen_after_micros=CASE WHEN resolution_frozen_before_micros IS NULL THEN NULL
    ELSE GREATEST(GREATEST(10000,legacy_credit_half_up(credit_micros)),legacy_credit_half_up(resolution_frozen_before_micros))
      -GREATEST(10000,legacy_credit_half_up(credit_micros)) END
WHERE credit_micros%10000<>0 OR available_before_micros%10000<>0 OR available_after_micros%10000<>0
  OR frozen_before_micros%10000<>0 OR frozen_after_micros%10000<>0
  OR resolution_available_before_micros%10000<>0 OR resolution_available_after_micros%10000<>0
  OR resolution_frozen_before_micros%10000<>0 OR resolution_frozen_after_micros%10000<>0;
ALTER TABLE kai_credit_payout_requests ENABLE TRIGGER USER;
SELECT sync_legacy_credit_audits('kai_credit_payout_requests',ARRAY['credit_micros','available_before_micros',
  'available_after_micros','frozen_before_micros','frozen_after_micros','resolution_available_before_micros',
  'resolution_available_after_micros','resolution_frozen_before_micros','resolution_frozen_after_micros']);

-- Rebuild the three supplier workflow liabilities from the normalized source
-- of truth.  These accounts are dedicated to commerce, so matching them to
-- outstanding receivables, settled net earnings and live payout freezes makes
-- subsequent refund/reversal/payout operations exact at cent precision.
CREATE TEMP TABLE legacy_0055_workflow_targets ON COMMIT DROP AS
WITH targets AS (
  SELECT supplier_subject_id AS subject_id,'supplier_receivable'::text AS account_kind,
    sum(amount_micros)::bigint AS amount_micros FROM (
      SELECT o.supplier_subject_id,
        GREATEST(0,COALESCE(a.captured_credit_micros,o.total_credit_micros)
          -COALESCE((SELECT sum(pr.credit_micros) FROM kai_credit_order_post_acceptance_refunds pr
            WHERE pr.order_id=o.id AND pr.status='succeeded'),0)) AS amount_micros
      FROM kai_credit_orders o JOIN kai_credit_order_reservations r ON r.order_id=o.id
      LEFT JOIN compute_fulfillment_acceptances a ON a.order_id=o.id
      WHERE r.status='captured' AND o.status NOT IN ('refunded','closed')
        AND NOT EXISTS(SELECT 1 FROM kai_credit_supplier_settlements s WHERE s.order_id=o.id)
        AND NOT EXISTS(SELECT 1 FROM compute_fulfillment_supplier_settlements s WHERE s.order_id=o.id)
      UNION ALL
      SELECT o.supplier_subject_id,s.net_credit_micros
      FROM physical_device_supplier_settlements s JOIN physical_device_orders o ON o.id=s.order_id
      WHERE s.status='pending'
  ) receivables GROUP BY supplier_subject_id
  UNION ALL
  SELECT subject_id,'supplier_earnings_available',sum(amount_micros)::bigint FROM (
    SELECT s.supplier_subject_id AS subject_id,s.net_credit_micros AS amount_micros FROM kai_credit_supplier_settlements s
      WHERE NOT EXISTS(SELECT 1 FROM kai_credit_fee_assessments a
        WHERE a.order_id=s.order_id AND a.kind='settlement')
    UNION ALL SELECT s.supplier_subject_id,s.net_credit_micros
      FROM compute_fulfillment_supplier_settlements s WHERE NOT EXISTS(
        SELECT 1 FROM kai_credit_fee_assessments a WHERE a.order_id=s.order_id AND a.kind='settlement')
    UNION ALL SELECT a.supplier_subject_id,a.net_credit_micros
      FROM kai_credit_fee_assessments a WHERE a.kind='settlement'
    UNION ALL SELECT o.supplier_subject_id,s.net_credit_micros
      FROM physical_device_supplier_settlements s JOIN physical_device_orders o ON o.id=s.order_id WHERE s.status='succeeded'
    UNION ALL SELECT a.supplier_subject_id,-a.net_credit_micros
      FROM kai_credit_fee_assessments a WHERE a.kind='reversal'
    UNION ALL SELECT p.subject_id,-p.credit_micros FROM kai_credit_payout_requests p
      WHERE p.status IN ('submitted','reviewing','paying','succeeded')
  ) earnings GROUP BY subject_id
  UNION ALL
  SELECT subject_id,'payout_frozen',sum(credit_micros)::bigint FROM kai_credit_payout_requests
    WHERE status IN ('submitted','reviewing','paying') GROUP BY subject_id
), relevant AS (
  SELECT subject_id,account_kind FROM targets
  UNION
  SELECT subject_id,account_kind FROM kai_credit_accounts
    WHERE owner_kind='subject' AND account_kind IN ('supplier_receivable','supplier_earnings_available','payout_frozen')
)
SELECT r.subject_id,r.account_kind,COALESCE(t.amount_micros,0)::bigint AS amount_micros
FROM relevant r LEFT JOIN targets t USING(subject_id,account_kind);

INSERT INTO kai_credit_accounts(id,owner_kind,subject_id,code,account_kind,allow_negative)
SELECT (substr(md5('0055:workflow-account:'||subject_id::text||':'||account_kind),1,8)||'-'
  ||substr(md5('0055:workflow-account:'||subject_id::text||':'||account_kind),9,4)||'-'
  ||substr(md5('0055:workflow-account:'||subject_id::text||':'||account_kind),13,4)||'-'
  ||substr(md5('0055:workflow-account:'||subject_id::text||':'||account_kind),17,4)||'-'
  ||substr(md5('0055:workflow-account:'||subject_id::text||':'||account_kind),21,12))::uuid,
  'subject',subject_id,'subject:'||subject_id::text||':'||account_kind,account_kind,false
FROM legacy_0055_workflow_targets ON CONFLICT DO NOTHING;

CREATE TEMP TABLE legacy_0055_workflow_deltas ON COMMIT DROP AS
SELECT a.id AS account_id,a.subject_id,a.account_kind,(t.amount_micros-
  COALESCE(sum(e.amount_micros) FILTER(WHERE tx.status='posted'),0))::bigint AS delta_micros,
  (substr(md5('0055:workflow:'||a.subject_id::text||':'||a.account_kind),1,8)||'-'
   ||substr(md5('0055:workflow:'||a.subject_id::text||':'||a.account_kind),9,4)||'-'
   ||substr(md5('0055:workflow:'||a.subject_id::text||':'||a.account_kind),13,4)||'-'
   ||substr(md5('0055:workflow:'||a.subject_id::text||':'||a.account_kind),17,4)||'-'
   ||substr(md5('0055:workflow:'||a.subject_id::text||':'||a.account_kind),21,12))::uuid AS transaction_id
FROM legacy_0055_workflow_targets t JOIN kai_credit_accounts a
  ON a.subject_id=t.subject_id AND a.account_kind=t.account_kind
LEFT JOIN kai_credit_entries e ON e.account_id=a.id
LEFT JOIN kai_credit_transactions tx ON tx.id=e.transaction_id
GROUP BY a.id,a.subject_id,a.account_kind,t.amount_micros
HAVING t.amount_micros<>COALESCE(sum(e.amount_micros) FILTER(WHERE tx.status='posted'),0);

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM legacy_0055_workflow_targets WHERE amount_micros<0)
    OR EXISTS(SELECT 1 FROM legacy_0055_workflow_deltas WHERE delta_micros%10000<>0) THEN
    RAISE EXCEPTION 'legacy supplier workflow balances cannot be reconciled safely';
  END IF;
END $$;
INSERT INTO kai_credit_transactions(id,idempotency_owner,scope,idempotency_key,payload_digest,
  reference_type,reference_id,description,status)
SELECT transaction_id,'migration:0055','legacy_workflow_reconciliation',
  'legacy-workflow:'||subject_id::text||':'||account_kind,
  md5(subject_id::text||':'||account_kind||':'||delta_micros::text),'adjustment',subject_id::text,
  '存量供应方卡时工作流两位小数对账','pending' FROM legacy_0055_workflow_deltas;
INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo)
SELECT (substr(md5('0055:workflow-entry:'||subject_id::text||':'||account_kind),1,8)||'-'
  ||substr(md5('0055:workflow-entry:'||subject_id::text||':'||account_kind),9,4)||'-'
  ||substr(md5('0055:workflow-entry:'||subject_id::text||':'||account_kind),13,4)||'-'
  ||substr(md5('0055:workflow-entry:'||subject_id::text||':'||account_kind),17,4)||'-'
  ||substr(md5('0055:workflow-entry:'||subject_id::text||':'||account_kind),21,12))::uuid,
  transaction_id,account_id,delta_micros,'存量供应方卡时工作流调整' FROM legacy_0055_workflow_deltas;
INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo)
SELECT (substr(md5('0055:workflow-clearing:'||subject_id::text||':'||account_kind),1,8)||'-'
  ||substr(md5('0055:workflow-clearing:'||subject_id::text||':'||account_kind),9,4)||'-'
  ||substr(md5('0055:workflow-clearing:'||subject_id::text||':'||account_kind),13,4)||'-'
  ||substr(md5('0055:workflow-clearing:'||subject_id::text||':'||account_kind),17,4)||'-'
  ||substr(md5('0055:workflow-clearing:'||subject_id::text||':'||account_kind),21,12))::uuid,
  transaction_id,'00000000-0000-4000-8000-000000000102'::uuid,-delta_micros,
  '存量供应方卡时工作流清算' FROM legacy_0055_workflow_deltas;
UPDATE kai_credit_transactions tx SET status='posted',posted_at=now()
FROM legacy_0055_workflow_deltas d WHERE tx.id=d.transaction_id;

SELECT audit_legacy_credit_columns('kai_credit_topup_reversals',ARRAY['credit_micros']);
ALTER TABLE kai_credit_topup_reversals DISABLE TRIGGER USER;
UPDATE kai_credit_topup_reversals SET credit_micros=GREATEST(10000,legacy_credit_half_up(credit_micros))
WHERE credit_micros % 10000 <> 0;
ALTER TABLE kai_credit_topup_reversals ENABLE TRIGGER USER;
SELECT sync_legacy_credit_audits('kai_credit_topup_reversals',ARRAY['credit_micros']);

DROP FUNCTION audit_legacy_credit_columns(regclass,text[]);
DROP FUNCTION sync_legacy_credit_audits(regclass,text[]);
DROP FUNCTION legacy_credit_half_up(bigint);

ALTER TABLE physical_device_products DROP CONSTRAINT physical_device_products_credit_discount_exact;
UPDATE physical_device_products SET
  list_unit_credit_micros = 40668660000,
  unit_credit_micros = 32534930000
WHERE id = '02672000-0000-4000-8000-000000000200';
ALTER TABLE physical_device_products ADD CONSTRAINT physical_device_products_credit_discount_cent
  CHECK (unit_credit_micros = (
    FLOOR(((list_unit_credit_micros::numeric * discount_basis_points / 10000) + 5000) / 10000) * 10000
  )::bigint) NOT VALID;

-- Demand discovery is card-hour only.  The obsolete RMB budget contract is
-- removed from storage rather than kept as a hidden legacy field.
ALTER TABLE compute_demands DROP COLUMN budget_max_cents, DROP COLUMN currency;

-- A valid percentage fee can round to 0.00 on a 0.01 card-hour trade. Keep a
-- posted, balanced two-leg ledger transaction for that case so settlement and
-- reversal remain fully auditable instead of inventing a non-zero fee.
ALTER TABLE kai_credit_fee_assessments DROP CONSTRAINT kai_credit_fee_assessments_check3;
ALTER TABLE kai_credit_fee_assessments ADD CONSTRAINT kai_credit_fee_assessments_ledger_required
  CHECK (ledger_transaction_id IS NOT NULL) NOT VALID;
ALTER TABLE physical_device_fee_assessments DROP CONSTRAINT physical_device_fee_assessments_check;
ALTER TABLE physical_device_fee_assessments ADD CONSTRAINT physical_device_fee_assessments_fee_range
  CHECK (service_fee_credit_micros >= 0 AND service_fee_credit_micros < gross_credit_micros) NOT VALID;

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
DECLARE supplier_available_amount bigint;
DECLARE supplier_receivable_amount bigint;
DECLARE buyer_available_amount bigint;
DECLARE platform_revenue_amount bigint;
BEGIN
  SELECT supplier_subject_id,buyer_subject_id,status INTO order_supplier,order_buyer,order_status
    FROM kai_credit_orders WHERE id=NEW.order_id;
  SELECT p.policy_state,p.schedule_id,p.schedule_version INTO policy_state,policy_schedule,policy_version
    FROM kai_credit_order_fee_policies p WHERE p.order_id=NEW.order_id;
  SELECT supplier_subject_id,period_start INTO period_supplier,period_date
    FROM kai_credit_supplier_fee_periods WHERE id=NEW.period_id;
  IF order_supplier IS DISTINCT FROM NEW.supplier_subject_id OR order_status NOT IN ('accepted','closed')
    OR policy_state IS DISTINCT FROM 'schedule_locked' OR policy_schedule IS DISTINCT FROM NEW.schedule_id
    OR policy_version IS DISTINCT FROM NEW.schedule_version OR period_supplier IS DISTINCT FROM NEW.supplier_subject_id
    OR period_date IS DISTINCT FROM NEW.period_start THEN RAISE EXCEPTION 'fee assessment relation mismatch'; END IF;
  IF (NEW.kind='settlement') <> (NEW.source_kind IN ('compute_settlement','renewal_settlement'))
    OR (NEW.kind='reversal') <> (NEW.source_kind='compute_settlement_refund') THEN
    RAISE EXCEPTION 'fee assessment source kind mismatch';
  END IF;
  IF NEW.kind='reversal' THEN
    SELECT order_id,supplier_subject_id,schedule_id,period_id
      INTO original_order,original_supplier,original_schedule,original_period
      FROM kai_credit_fee_assessments WHERE id=NEW.original_assessment_id AND kind='settlement';
    IF original_order IS DISTINCT FROM NEW.order_id OR original_supplier IS DISTINCT FROM NEW.supplier_subject_id
      OR original_schedule IS DISTINCT FROM NEW.schedule_id OR original_period IS DISTINCT FROM NEW.period_id THEN
      RAISE EXCEPTION 'fee reversal must match its original assessment';
    END IF;
  END IF;
  IF NEW.service_fee_credit_micros < 0 OR NEW.net_credit_micros <= 0 OR NEW.ledger_transaction_id IS NULL THEN
    RAISE EXCEPTION 'fee ledger amounts are invalid';
  END IF;
  SELECT status,scope,reference_type,reference_id
    INTO transaction_status,transaction_scope,transaction_reference_type,transaction_reference_id
    FROM kai_credit_transactions WHERE id=NEW.ledger_transaction_id;
  SELECT count(*),
    COALESCE(sum(CASE WHEN a.subject_id=NEW.supplier_subject_id AND a.account_kind='supplier_earnings_available' THEN e.amount_micros ELSE 0 END),0),
    COALESCE(sum(CASE WHEN a.subject_id=NEW.supplier_subject_id AND a.account_kind='supplier_receivable' THEN e.amount_micros ELSE 0 END),0),
    COALESCE(sum(CASE WHEN a.subject_id=order_buyer AND a.account_kind='available' THEN e.amount_micros ELSE 0 END),0),
    COALESCE(sum(CASE WHEN a.id='00000000-0000-4000-8000-000000000103' THEN e.amount_micros ELSE 0 END),0)
    INTO entry_count,supplier_available_amount,supplier_receivable_amount,buyer_available_amount,platform_revenue_amount
    FROM kai_credit_entries e JOIN kai_credit_accounts a ON a.id=e.account_id
    WHERE e.transaction_id=NEW.ledger_transaction_id;
  IF transaction_status IS DISTINCT FROM 'posted'
    OR entry_count <> (CASE WHEN NEW.service_fee_credit_micros=0 THEN 2 ELSE 3 END)
    OR transaction_reference_id IS DISTINCT FROM NEW.order_id::text THEN RAISE EXCEPTION 'invalid fee ledger transaction'; END IF;
  IF NEW.kind='settlement' AND (transaction_scope IS DISTINCT FROM 'CREDIT_SUPPLIER_SETTLEMENT_WITH_FEE'
    OR transaction_reference_type IS DISTINCT FROM 'settlement' OR supplier_receivable_amount <> -NEW.gross_credit_micros
    OR supplier_available_amount <> NEW.net_credit_micros OR platform_revenue_amount <> NEW.service_fee_credit_micros
    OR buyer_available_amount <> 0) THEN RAISE EXCEPTION 'invalid settlement fee ledger legs'; END IF;
  IF NEW.kind='reversal' AND (transaction_scope IS DISTINCT FROM 'CREDIT_SETTLEMENT_REFUND_WITH_FEE_REVERSAL'
    OR transaction_reference_type IS DISTINCT FROM 'service_fee_reversal' OR supplier_receivable_amount <> 0
    OR supplier_available_amount <> -NEW.net_credit_micros OR platform_revenue_amount <> -NEW.service_fee_credit_micros
    OR buyer_available_amount <> NEW.gross_credit_micros) THEN RAISE EXCEPTION 'invalid fee reversal ledger legs'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_physical_device_fee_assessment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_supplier uuid; DECLARE order_buyer uuid; DECLARE order_gross bigint; DECLARE order_status text;
DECLARE period_supplier uuid; DECLARE period_date date; DECLARE transaction_status text; DECLARE transaction_scope text;
DECLARE transaction_reference_id text; DECLARE entry_count integer; DECLARE buyer_reserved_amount bigint;
DECLARE supplier_receivable_amount bigint; DECLARE platform_revenue_amount bigint;
BEGIN
  SELECT supplier_subject_id,buyer_subject_id,gross_credit_micros,status
    INTO order_supplier,order_buyer,order_gross,order_status FROM physical_device_orders WHERE id=NEW.order_id;
  SELECT supplier_subject_id,period_start INTO period_supplier,period_date
    FROM kai_credit_supplier_fee_periods WHERE id=NEW.period_id;
  SELECT status,scope,reference_id INTO transaction_status,transaction_scope,transaction_reference_id
    FROM kai_credit_transactions WHERE id=NEW.ledger_transaction_id;
  SELECT count(*),
    COALESCE(sum(CASE WHEN a.subject_id=order_buyer AND a.account_kind='reserved' THEN e.amount_micros ELSE 0 END),0),
    COALESCE(sum(CASE WHEN a.subject_id=NEW.supplier_subject_id AND a.account_kind='supplier_receivable' THEN e.amount_micros ELSE 0 END),0),
    COALESCE(sum(CASE WHEN a.id='00000000-0000-4000-8000-000000000103' THEN e.amount_micros ELSE 0 END),0)
    INTO entry_count,buyer_reserved_amount,supplier_receivable_amount,platform_revenue_amount
    FROM kai_credit_entries e JOIN kai_credit_accounts a ON a.id=e.account_id
    WHERE e.transaction_id=NEW.ledger_transaction_id;
  IF order_supplier IS DISTINCT FROM NEW.supplier_subject_id OR order_gross <> NEW.gross_credit_micros
    OR order_status IS DISTINCT FROM 'shipping' OR period_supplier IS DISTINCT FROM NEW.supplier_subject_id
    OR period_date IS DISTINCT FROM NEW.period_start OR transaction_status IS DISTINCT FROM 'posted'
    OR transaction_scope IS DISTINCT FROM 'DEVICE_ORDER_CAPTURE' OR transaction_reference_id IS DISTINCT FROM NEW.order_id::text
    OR entry_count <> (CASE WHEN NEW.service_fee_credit_micros=0 THEN 2 ELSE 3 END)
    OR buyer_reserved_amount <> -NEW.gross_credit_micros OR supplier_receivable_amount <> NEW.net_credit_micros
    OR platform_revenue_amount <> NEW.service_fee_credit_micros THEN
    RAISE EXCEPTION 'invalid physical device fee assessment';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE kai_credit_orders ADD CONSTRAINT kai_credit_orders_total_cent_formula
  CHECK (total_credit_micros = (
    CEIL(CEIL(quantity * unit_credit_micros)::numeric / 10000) * 10000
  )::bigint) NOT VALID;

CREATE TRIGGER offer_templates_cent_guard BEFORE INSERT OR UPDATE ON offer_templates
  FOR EACH ROW EXECUTE FUNCTION require_card_hour_cent_columns('suggested_unit_credit_micros', 'approved_unit_credit_micros');
CREATE TRIGGER offer_audits_cent_guard BEFORE INSERT OR UPDATE ON offer_audit_versions
  FOR EACH ROW EXECUTE FUNCTION require_card_hour_cent_columns('approved_unit_credit_micros');
CREATE TRIGGER credit_listings_cent_guard BEFORE INSERT OR UPDATE ON credit_market_listings
  FOR EACH ROW EXECUTE FUNCTION require_card_hour_cent_columns('unit_credit_micros');
CREATE TRIGGER credit_topups_cent_guard BEFORE INSERT OR UPDATE ON kai_credit_topups
  FOR EACH ROW EXECUTE FUNCTION require_card_hour_cent_columns('credit_micros', 'reversed_credit_micros');
CREATE TRIGGER credit_orders_cent_guard BEFORE INSERT OR UPDATE ON kai_credit_orders
  FOR EACH ROW EXECUTE FUNCTION require_card_hour_cent_columns('unit_credit_micros', 'total_credit_micros');
CREATE TRIGGER credit_reservations_cent_guard BEFORE INSERT OR UPDATE ON kai_credit_order_reservations
  FOR EACH ROW EXECUTE FUNCTION require_card_hour_cent_columns('credit_micros');
CREATE TRIGGER credit_mutual_refunds_cent_guard BEFORE INSERT OR UPDATE ON kai_credit_order_mutual_refunds
  FOR EACH ROW EXECUTE FUNCTION require_card_hour_cent_columns('credit_micros');
CREATE TRIGGER credit_aftercare_refunds_cent_guard BEFORE INSERT OR UPDATE ON kai_credit_order_post_acceptance_refunds
  FOR EACH ROW EXECUTE FUNCTION require_card_hour_cent_columns('credit_micros');
CREATE TRIGGER credit_dispute_decisions_cent_guard BEFORE INSERT OR UPDATE ON kai_credit_order_dispute_decisions
  FOR EACH ROW EXECUTE FUNCTION require_card_hour_cent_columns('credit_micros');
CREATE TRIGGER credit_aftercare_decisions_cent_guard BEFORE INSERT OR UPDATE ON kai_credit_post_acceptance_refund_decisions
  FOR EACH ROW EXECUTE FUNCTION require_card_hour_cent_columns('credit_micros');
CREATE TRIGGER credit_supplier_settlements_cent_guard BEFORE INSERT OR UPDATE ON kai_credit_supplier_settlements
  FOR EACH ROW EXECUTE FUNCTION require_card_hour_cent_columns('credit_micros', 'service_fee_credit_micros');
CREATE TRIGGER credit_payouts_cent_guard BEFORE INSERT OR UPDATE ON kai_credit_payout_requests
  FOR EACH ROW EXECUTE FUNCTION require_card_hour_cent_columns('credit_micros', 'available_before_micros',
    'available_after_micros', 'frozen_before_micros', 'frozen_after_micros',
    'resolution_available_before_micros', 'resolution_available_after_micros',
    'resolution_frozen_before_micros', 'resolution_frozen_after_micros');
CREATE TRIGGER credit_topup_reversals_cent_guard BEFORE INSERT OR UPDATE ON kai_credit_topup_reversals
  FOR EACH ROW EXECUTE FUNCTION require_card_hour_cent_columns('credit_micros');
CREATE TRIGGER credit_fee_assessments_cent_guard BEFORE INSERT OR UPDATE ON kai_credit_fee_assessments
  FOR EACH ROW EXECUTE FUNCTION require_card_hour_cent_columns('gross_credit_micros', 'service_fee_credit_micros',
    'net_credit_micros', 'cumulative_before_micros', 'cumulative_after_micros');
CREATE TRIGGER credit_fee_segments_cent_guard BEFORE INSERT OR UPDATE ON kai_credit_fee_assessment_segments
  FOR EACH ROW EXECUTE FUNCTION require_card_hour_cent_columns('settled_credit_micros', 'service_fee_credit_micros');
CREATE TRIGGER credit_fee_reversals_cent_guard BEFORE INSERT OR UPDATE ON kai_credit_fee_reversal_allocations
  FOR EACH ROW EXECUTE FUNCTION require_card_hour_cent_columns('reversed_credit_micros', 'reversed_fee_credit_micros');
CREATE TRIGGER credit_fee_tiers_cent_guard BEFORE INSERT OR UPDATE ON kai_credit_fee_tiers
  FOR EACH ROW EXECUTE FUNCTION require_card_hour_cent_columns('lower_bound_micros', 'upper_bound_micros');
CREATE TRIGGER credit_fee_periods_cent_guard BEFORE INSERT OR UPDATE ON kai_credit_supplier_fee_periods
  FOR EACH ROW EXECUTE FUNCTION require_card_hour_cent_columns('net_settled_credit_micros');
CREATE TRIGGER device_products_cent_guard BEFORE INSERT OR UPDATE ON physical_device_products
  FOR EACH ROW EXECUTE FUNCTION require_card_hour_cent_columns('list_unit_credit_micros', 'unit_credit_micros');
CREATE TRIGGER device_orders_cent_guard BEFORE INSERT OR UPDATE ON physical_device_orders
  FOR EACH ROW EXECUTE FUNCTION require_card_hour_cent_columns('unit_credit_micros', 'gross_credit_micros', 'service_fee_credit_micros', 'supplier_net_credit_micros');
CREATE TRIGGER device_settlements_cent_guard BEFORE INSERT OR UPDATE ON physical_device_supplier_settlements
  FOR EACH ROW EXECUTE FUNCTION require_card_hour_cent_columns('gross_credit_micros', 'service_fee_credit_micros', 'net_credit_micros');
CREATE TRIGGER device_fee_assessments_cent_guard BEFORE INSERT OR UPDATE ON physical_device_fee_assessments
  FOR EACH ROW EXECUTE FUNCTION require_card_hour_cent_columns('gross_credit_micros', 'service_fee_credit_micros',
    'net_credit_micros', 'cumulative_before_micros', 'cumulative_after_micros');
CREATE TRIGGER device_fee_segments_cent_guard BEFORE INSERT OR UPDATE ON physical_device_fee_assessment_segments
  FOR EACH ROW EXECUTE FUNCTION require_card_hour_cent_columns('settled_credit_micros', 'service_fee_credit_micros');
CREATE TRIGGER fulfillment_acceptance_cent_guard BEFORE INSERT OR UPDATE ON compute_fulfillment_acceptances
  FOR EACH ROW EXECUTE FUNCTION require_card_hour_cent_columns('captured_credit_micros', 'refunded_credit_micros');
CREATE TRIGGER fulfillment_issue_cent_guard BEFORE INSERT OR UPDATE ON compute_fulfillment_issue_decisions
  FOR EACH ROW EXECUTE FUNCTION require_card_hour_cent_columns('metered_credit_micros', 'remedy_refund_credit_micros', 'provider_credit_micros', 'buyer_refund_credit_micros');
CREATE TRIGGER fulfillment_settlement_cent_guard BEFORE INSERT OR UPDATE ON compute_fulfillment_supplier_settlements
  FOR EACH ROW EXECUTE FUNCTION require_card_hour_cent_columns('credit_micros', 'service_fee_credit_micros');
