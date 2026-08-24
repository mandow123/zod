-- Formal supplier inquiry catalog for Shanghai Honghuan.
-- This domain is intentionally independent from the private workbook candidates in 0058/0059.

CREATE TABLE supplier_inquiry_catalog_sources (
  supplier_id text PRIMARY KEY CHECK (supplier_id ~ '^supplier-[a-z0-9-]{3,80}$'),
  legal_name text NOT NULL CHECK (char_length(legal_name) BETWEEN 2 AND 120),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 80),
  disclosure_status text NOT NULL CHECK (disclosure_status='platform_imported_unverified'),
  logo_https_url text NOT NULL CHECK (logo_https_url ~ '^https://'),
  logo_version text NOT NULL CHECK (char_length(logo_version) BETWEEN 1 AND 40),
  logo_source_sha256 text NOT NULL CHECK (logo_source_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  logo_source_label text NOT NULL CHECK (char_length(logo_source_label) BETWEEN 3 AND 120),
  logo_uploaded_by text NOT NULL CHECK (char_length(logo_uploaded_by) BETWEEN 3 AND 120),
  logo_authorization_status text NOT NULL CHECK (logo_authorization_status='unverified'),
  logo_provenance text NOT NULL CHECK (logo_provenance='user_provided'),
  publication_directive_ref text NOT NULL CHECK (char_length(publication_directive_ref) BETWEEN 16 AND 300),
  supplier_authorization_evidence_ref text,
  quote_evidence_sha256 text NOT NULL CHECK (quote_evidence_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  quote_evidence_storage_ref text NOT NULL CHECK (char_length(quote_evidence_storage_ref) BETWEEN 16 AND 300),
  quote_evidence_status text NOT NULL CHECK (quote_evidence_status='user_provided_unverified'),
  source_kind text NOT NULL CHECK (source_kind='USER_PROVIDED_SUPPLIER_QUOTE'),
  source_verification_status text NOT NULL CHECK (source_verification_status='unverified'),
  source_observed_at date NOT NULL,
  valid_until timestamptz NOT NULL,
  evidence_complete boolean NOT NULL CHECK (evidence_complete=true),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until > source_observed_at::timestamptz)
);

CREATE TABLE supplier_inquiry_catalog_items (
  id uuid PRIMARY KEY,
  canonical_id text NOT NULL UNIQUE CHECK (canonical_id ~ '^(gpu|server)-honghuan-[a-z0-9-]{6,100}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  supplier_id text NOT NULL REFERENCES supplier_inquiry_catalog_sources(supplier_id),
  catalog_kind text NOT NULL CHECK (catalog_kind IN ('hourly_gpu','contract_monthly')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 120),
  model text NOT NULL CHECK (model IN ('A100','H100','H200','B200','B300')),
  form_factor text CHECK (form_factor IN ('SXM4','SXM','NVL')),
  memory_gb numeric(8,2) CHECK (memory_gb > 0),
  gpu_count integer CHECK (gpu_count > 0),
  spec_snapshot jsonb NOT NULL CHECK (jsonb_typeof(spec_snapshot)='object'),
  quantity_unit text NOT NULL CHECK (quantity_unit IN ('instance','server')),
  quantity_min integer NOT NULL CHECK (quantity_min > 0),
  quantity_max integer NOT NULL CHECK (quantity_max >= quantity_min),
  quantity_allowed_values integer[],
  billing_mode text NOT NULL CHECK (billing_mode IN ('hourly','monthly')),
  billing_unit text NOT NULL CHECK (billing_unit IN ('GPU_HOUR','SERVER_MONTH')),
  reference_hourly_minor bigint CHECK (reference_hourly_minor > 0),
  reference_daily_minor bigint CHECK (reference_daily_minor > 0),
  reference_monthly_minor bigint CHECK (reference_monthly_minor > 0),
  reference_currency text NOT NULL CHECK (reference_currency='KAI_CARD_HOUR'),
  reference_precision smallint NOT NULL CHECK (reference_precision=2),
  reference_status text NOT NULL CHECK (reference_status='reference_only'),
  source_observed_at date NOT NULL,
  valid_until timestamptz NOT NULL,
  availability_status text NOT NULL CHECK (availability_status='inquiry_required'),
  delivery_mode text NOT NULL CHECK (delivery_mode='manual'),
  delivery_lead_time_value integer CHECK (delivery_lead_time_value > 0),
  delivery_lead_time_unit text CHECK (delivery_lead_time_unit='month'),
  delivery_lead_time_status text NOT NULL CHECK (delivery_lead_time_status IN ('supplier_declared','inquiry_confirmation_required')),
  purchase_mode text NOT NULL CHECK (purchase_mode='inquiry_then_quote'),
  purchasable boolean NOT NULL CHECK (purchasable=false),
  inventory_commitment boolean NOT NULL CHECK (inventory_commitment=false),
  order_creation boolean NOT NULL CHECK (order_creation=false),
  inquiry_available boolean NOT NULL CHECK (inquiry_available=true),
  simulation boolean NOT NULL CHECK (simulation=false),
  legal_review_required boolean NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until > source_observed_at::timestamptz),
  CHECK ((catalog_kind='hourly_gpu' AND billing_mode='hourly' AND billing_unit='GPU_HOUR'
      AND gpu_count IS NOT NULL AND quantity_unit='instance' AND quantity_min=1 AND quantity_max=100000
      AND quantity_allowed_values IS NULL AND reference_hourly_minor IS NOT NULL AND reference_daily_minor IS NOT NULL
      AND reference_monthly_minor IS NULL AND delivery_lead_time_value IS NULL AND delivery_lead_time_unit IS NULL
      AND delivery_lead_time_status='inquiry_confirmation_required' AND legal_review_required=false)
    OR (catalog_kind='contract_monthly' AND billing_mode='monthly' AND billing_unit='SERVER_MONTH'
      AND gpu_count IS NULL AND memory_gb IS NULL AND form_factor IS NULL AND quantity_unit='server'
      AND quantity_min=32 AND quantity_max=128 AND quantity_allowed_values=ARRAY[32,64,128]
      AND reference_hourly_minor IS NULL AND reference_daily_minor IS NULL AND reference_monthly_minor IS NOT NULL
      AND delivery_lead_time_value=4 AND delivery_lead_time_unit='month'
      AND delivery_lead_time_status='supplier_declared' AND legal_review_required=true))
);
CREATE INDEX supplier_inquiry_catalog_public_page
  ON supplier_inquiry_catalog_items(created_at DESC,id DESC) WHERE active;
CREATE INDEX supplier_inquiry_catalog_public_filters
  ON supplier_inquiry_catalog_items(catalog_kind,model,created_at DESC,id DESC) WHERE active;

CREATE TABLE supplier_inquiry_catalog_source_prices (
  catalog_item_id uuid PRIMARY KEY REFERENCES supplier_inquiry_catalog_items(id),
  source_currency text NOT NULL CHECK (source_currency='CNY'),
  source_hourly_minor bigint CHECK (source_hourly_minor > 0),
  source_daily_minor bigint CHECK (source_daily_minor > 0),
  source_monthly_minor bigint CHECK (source_monthly_minor > 0),
  listing_multiplier_millis integer NOT NULL CHECK (listing_multiplier_millis=1500),
  conversion_policy_version text NOT NULL CHECK (conversion_policy_version='KAI-SCH-1.002'),
  settlement_fee_applied boolean NOT NULL CHECK (settlement_fee_applied=false),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^sha256:[a-f0-9]{64}$'),
  evidence_storage_ref text NOT NULL CHECK (char_length(evidence_storage_ref) BETWEEN 16 AND 300),
  evidence_status text NOT NULL CHECK (evidence_status='user_provided_unverified'),
  raw_legal_terms jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((source_hourly_minor IS NOT NULL AND source_daily_minor IS NOT NULL AND source_monthly_minor IS NULL)
    OR (source_hourly_minor IS NULL AND source_daily_minor IS NULL AND source_monthly_minor IS NOT NULL))
);

ALTER TABLE resource_inquiries ALTER COLUMN candidate_id DROP NOT NULL;
ALTER TABLE resource_inquiries ALTER COLUMN gpu_count DROP NOT NULL;
ALTER TABLE resource_inquiries DROP CONSTRAINT resource_inquiries_gpu_count_check;
ALTER TABLE resource_inquiries ADD CONSTRAINT resource_inquiries_gpu_count_check
  CHECK (gpu_count IS NULL OR (gpu_count > 0 AND gpu_count <= 400000));
ALTER TABLE resource_inquiries
  ADD COLUMN supplier_catalog_item_id uuid REFERENCES supplier_inquiry_catalog_items(id),
  ADD COLUMN supplier_catalog_version integer CHECK (supplier_catalog_version > 0),
  ADD COLUMN requested_quantity integer CHECK (requested_quantity > 0 AND requested_quantity <= 100000),
  ADD COLUMN supplier_snapshot jsonb,
  ADD COLUMN resource_snapshot jsonb,
  ADD COLUMN reference_price_snapshot jsonb,
  ADD COLUMN source_snapshot jsonb,
  ADD CONSTRAINT resource_inquiries_exactly_one_catalog_source CHECK (
    (candidate_id IS NOT NULL AND supplier_catalog_item_id IS NULL AND requested_quantity IS NULL
      AND supplier_catalog_version IS NULL AND supplier_snapshot IS NULL AND resource_snapshot IS NULL
      AND reference_price_snapshot IS NULL AND source_snapshot IS NULL AND gpu_count IS NOT NULL)
    OR
    (candidate_id IS NULL AND supplier_catalog_item_id IS NOT NULL AND requested_quantity IS NOT NULL
      AND supplier_catalog_version IS NOT NULL AND supplier_snapshot IS NOT NULL AND resource_snapshot IS NOT NULL
      AND reference_price_snapshot IS NOT NULL AND source_snapshot IS NOT NULL)
  );
CREATE INDEX resource_inquiries_supplier_catalog_item
  ON resource_inquiries(supplier_catalog_item_id,created_at DESC) WHERE supplier_catalog_item_id IS NOT NULL;

CREATE FUNCTION protect_supplier_inquiry_catalog() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'supplier inquiry catalog snapshots are immutable; add a new version via migration';
END;
$$;
CREATE TRIGGER supplier_inquiry_catalog_sources_immutable BEFORE UPDATE OR DELETE ON supplier_inquiry_catalog_sources
  FOR EACH ROW EXECUTE FUNCTION protect_supplier_inquiry_catalog();
CREATE TRIGGER supplier_inquiry_catalog_items_immutable BEFORE UPDATE OR DELETE ON supplier_inquiry_catalog_items
  FOR EACH ROW EXECUTE FUNCTION protect_supplier_inquiry_catalog();
CREATE TRIGGER supplier_inquiry_catalog_source_prices_immutable BEFORE UPDATE OR DELETE ON supplier_inquiry_catalog_source_prices
  FOR EACH ROW EXECUTE FUNCTION protect_supplier_inquiry_catalog();

CREATE FUNCTION protect_resource_inquiry_supplier_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.candidate_id IS DISTINCT FROM OLD.candidate_id
    OR NEW.supplier_catalog_item_id IS DISTINCT FROM OLD.supplier_catalog_item_id
    OR NEW.supplier_catalog_version IS DISTINCT FROM OLD.supplier_catalog_version
    OR NEW.requested_quantity IS DISTINCT FROM OLD.requested_quantity
    OR NEW.gpu_count IS DISTINCT FROM OLD.gpu_count
    OR NEW.billing_mode IS DISTINCT FROM OLD.billing_mode
    OR NEW.supplier_snapshot IS DISTINCT FROM OLD.supplier_snapshot
    OR NEW.resource_snapshot IS DISTINCT FROM OLD.resource_snapshot
    OR NEW.reference_price_snapshot IS DISTINCT FROM OLD.reference_price_snapshot
    OR NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot THEN
    RAISE EXCEPTION 'resource inquiry catalog and price snapshots are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER resource_inquiries_supplier_snapshot_immutable BEFORE UPDATE ON resource_inquiries
  FOR EACH ROW EXECUTE FUNCTION protect_resource_inquiry_supplier_snapshot();

INSERT INTO supplier_inquiry_catalog_sources(
  supplier_id,legal_name,display_name,disclosure_status,logo_https_url,logo_version,logo_source_sha256,
  logo_source_label,logo_uploaded_by,logo_authorization_status,logo_provenance,publication_directive_ref,
  supplier_authorization_evidence_ref,quote_evidence_sha256,quote_evidence_storage_ref,quote_evidence_status,
  source_kind,source_verification_status,source_observed_at,valid_until,evidence_complete)
VALUES('supplier-shanghai-honghuan','上海鸿欢网络科技有限公司','上海鸿欢','platform_imported_unverified',
  'https://cloud.kai.com/assets/suppliers/shanghai-honghuan.jpg','v1',
  'sha256:db1ed9e4cddc31f4b6e641bbc9179443e5a5d251a31abe28109c3fa55f32a70f',
  '平台导入/主站已公开','platform-user-import','unverified','user_provided',
  'platform-directive:2026-08-20:honghuan-formal-catalog-b1',NULL,
  'sha256:e3e7ac76dbe0d6b19b81babedbf591f6f5ad3068911f7d24a75c4bce585b55a9',
  'evidence://supplier-shanghai-honghuan/quotes/2026-08-19-v1','user_provided_unverified',
  'USER_PROVIDED_SUPPLIER_QUOTE','unverified','2026-08-19',
  '2026-09-19T03:59:59Z',true)
ON CONFLICT(supplier_id) DO NOTHING;

INSERT INTO supplier_inquiry_catalog_items(id,canonical_id,version,supplier_id,catalog_kind,title,model,form_factor,
  memory_gb,gpu_count,spec_snapshot,quantity_unit,quantity_min,quantity_max,quantity_allowed_values,billing_mode,billing_unit,
  reference_hourly_minor,reference_daily_minor,reference_monthly_minor,reference_currency,reference_precision,reference_status,
  source_observed_at,valid_until,availability_status,delivery_mode,delivery_lead_time_value,delivery_lead_time_unit,
  delivery_lead_time_status,purchase_mode,purchasable,inventory_commitment,order_creation,inquiry_available,simulation,
  legal_review_required,created_at,updated_at)
VALUES
('62000000-0000-4000-8000-000000000001','gpu-honghuan-a100-sxm4-80gb-1',1,'supplier-shanghai-honghuan','hourly_gpu','A100 SXM4 80GB · 单卡','A100','SXM4',80,1,
 '{"gpu":{"model":"A100","formFactor":"SXM4","advertisedMemoryGb":80,"environmentObservedMemoryGb":null,"countPerInstance":1},"cpu":{"description":null},"memory":{"description":null},"storage":{"description":"256GB"},"software":{"cudaVersion":null,"pythonVersion":null,"pytorchStatus":"unknown"},"notes":["CPU、内存与网络需询价确认"]}'::jsonb,
 'instance',1,100000,NULL,'hourly','GPU_HOUR',2844,68263,NULL,'KAI_CARD_HOUR',2,'reference_only','2026-08-19','2026-09-19T03:59:59Z','inquiry_required','manual',NULL,NULL,'inquiry_confirmation_required','inquiry_then_quote',false,false,false,true,false,false,now(),now()),
('62000000-0000-4000-8000-000000000002','gpu-honghuan-a100-sxm4-80gb-2',1,'supplier-shanghai-honghuan','hourly_gpu','A100 SXM4 80GB · 双卡','A100','SXM4',80,2,
 '{"gpu":{"model":"A100","formFactor":"SXM4","advertisedMemoryGb":80,"environmentObservedMemoryGb":null,"countPerInstance":2},"cpu":{"description":null},"memory":{"description":null},"storage":{"description":"256GB"},"software":{"cudaVersion":null,"pythonVersion":null,"pytorchStatus":"unknown"},"notes":["CPU、内存与网络需询价确认"]}'::jsonb,
 'instance',1,100000,NULL,'hourly','GPU_HOUR',5389,129341,NULL,'KAI_CARD_HOUR',2,'reference_only','2026-08-19','2026-09-19T03:59:59Z','inquiry_required','manual',NULL,NULL,'inquiry_confirmation_required','inquiry_then_quote',false,false,false,true,false,false,now(),now()),
('62000000-0000-4000-8000-000000000003','gpu-honghuan-h100-sxm-80gb-1',1,'supplier-shanghai-honghuan','hourly_gpu','H100 SXM 80GB · 单卡','H100','SXM',80,1,
 '{"gpu":{"model":"H100","formFactor":"SXM","advertisedMemoryGb":80,"environmentObservedMemoryGb":null,"countPerInstance":1},"cpu":{"description":"28核"},"memory":{"description":"200GB"},"storage":{"description":"100GB，可扩容（另报价）"},"software":{"cudaVersion":null,"pythonVersion":null,"pytorchStatus":"unknown"},"notes":["四卡方案仅支持询价，不构成独立SKU","网络需询价确认"]}'::jsonb,
 'instance',1,100000,NULL,'hourly','GPU_HOUR',8982,215569,NULL,'KAI_CARD_HOUR',2,'reference_only','2026-08-19','2026-09-19T03:59:59Z','inquiry_required','manual',NULL,NULL,'inquiry_confirmation_required','inquiry_then_quote',false,false,false,true,false,false,now(),now()),
('62000000-0000-4000-8000-000000000004','gpu-honghuan-h100-sxm-80gb-2',1,'supplier-shanghai-honghuan','hourly_gpu','H100 SXM 80GB · 双卡','H100','SXM',80,2,
 '{"gpu":{"model":"H100","formFactor":"SXM","advertisedMemoryGb":80,"environmentObservedMemoryGb":null,"countPerInstance":2},"cpu":{"description":"28核"},"memory":{"description":"200GB"},"storage":{"description":"100GB，可扩容（另报价）"},"software":{"cudaVersion":null,"pythonVersion":null,"pytorchStatus":"unknown"},"notes":["四卡方案仅支持询价，不构成独立SKU","网络需询价确认"]}'::jsonb,
 'instance',1,100000,NULL,'hourly','GPU_HOUR',16317,391617,NULL,'KAI_CARD_HOUR',2,'reference_only','2026-08-19','2026-09-19T03:59:59Z','inquiry_required','manual',NULL,NULL,'inquiry_confirmation_required','inquiry_then_quote',false,false,false,true,false,false,now(),now()),
('62000000-0000-4000-8000-000000000005','gpu-honghuan-h200-nvl-1',1,'supplier-shanghai-honghuan','hourly_gpu','H200 NVL · 单卡','H200','NVL',140,1,
 '{"gpu":{"model":"H200","formFactor":"NVL","advertisedMemoryGb":140,"environmentObservedMemoryGb":144,"countPerInstance":1},"cpu":{"description":"系统观测512线程"},"memory":{"description":"宿主内存环境观测约2.2TB"},"storage":{"description":"套餐256GB；当前可写约50GB，交付时复核"},"software":{"cudaVersion":"13","pythonVersion":"3.12","pytorchStatus":"not_installed"},"notes":["环境观测不构成库存或最终交付规格承诺","网络需询价确认"]}'::jsonb,
 'instance',1,100000,NULL,'hourly','GPU_HOUR',8832,211976,NULL,'KAI_CARD_HOUR',2,'reference_only','2026-08-19','2026-09-19T03:59:59Z','inquiry_required','manual',NULL,NULL,'inquiry_confirmation_required','inquiry_then_quote',false,false,false,true,false,false,now(),now()),
('62000000-0000-4000-8000-000000000006','gpu-honghuan-h200-nvl-2',1,'supplier-shanghai-honghuan','hourly_gpu','H200 NVL · 双卡','H200','NVL',140,2,
 '{"gpu":{"model":"H200","formFactor":"NVL","advertisedMemoryGb":140,"environmentObservedMemoryGb":null,"countPerInstance":2},"cpu":{"description":null},"memory":{"description":null},"storage":{"description":"256GB"},"software":{"cudaVersion":null,"pythonVersion":null,"pytorchStatus":"unknown"},"notes":["CPU、内存、网络与软件环境需询价确认"]}'::jsonb,
 'instance',1,100000,NULL,'hourly','GPU_HOUR',13772,330539,NULL,'KAI_CARD_HOUR',2,'reference_only','2026-08-19','2026-09-19T03:59:59Z','inquiry_required','manual',NULL,NULL,'inquiry_confirmation_required','inquiry_then_quote',false,false,false,true,false,false,now(),now()),
('62000000-0000-4000-8000-000000000007','gpu-honghuan-b200-179gb-1',1,'supplier-shanghai-honghuan','hourly_gpu','B200 179GB · 单卡','B200',NULL,179,1,
 '{"gpu":{"model":"B200","formFactor":null,"advertisedMemoryGb":179,"environmentObservedMemoryGb":null,"countPerInstance":1},"cpu":{"description":null},"memory":{"description":null},"storage":{"description":"256GB"},"software":{"cudaVersion":null,"pythonVersion":null,"pytorchStatus":"unknown"},"notes":["CPU、内存与网络需询价确认"]}'::jsonb,
 'instance',1,100000,NULL,'hourly','GPU_HOUR',14371,344910,NULL,'KAI_CARD_HOUR',2,'reference_only','2026-08-19','2026-09-19T03:59:59Z','inquiry_required','manual',NULL,NULL,'inquiry_confirmation_required','inquiry_then_quote',false,false,false,true,false,false,now(),now()),
('62000000-0000-4000-8000-000000000008','gpu-honghuan-b200-179gb-2',1,'supplier-shanghai-honghuan','hourly_gpu','B200 179GB · 双卡','B200',NULL,179,2,
 '{"gpu":{"model":"B200","formFactor":null,"advertisedMemoryGb":179,"environmentObservedMemoryGb":null,"countPerInstance":2},"cpu":{"description":"40核"},"memory":{"description":"400GB"},"storage":{"description":"100GB，可扩容（另报价）"},"software":{"cudaVersion":null,"pythonVersion":null,"pytorchStatus":"unknown"},"notes":["网络需询价确认"]}'::jsonb,
 'instance',1,100000,NULL,'hourly','GPU_HOUR',27844,668263,NULL,'KAI_CARD_HOUR',2,'reference_only','2026-08-19','2026-09-19T03:59:59Z','inquiry_required','manual',NULL,NULL,'inquiry_confirmation_required','inquiry_then_quote',false,false,false,true,false,false,now(),now()),
('62000000-0000-4000-8000-000000000009','gpu-honghuan-b200-179gb-4',1,'supplier-shanghai-honghuan','hourly_gpu','B200 179GB · 四卡','B200',NULL,179,4,
 '{"gpu":{"model":"B200","formFactor":null,"advertisedMemoryGb":179,"environmentObservedMemoryGb":null,"countPerInstance":4},"cpu":{"description":null},"memory":{"description":null},"storage":{"description":"256GB"},"software":{"cudaVersion":null,"pythonVersion":null,"pytorchStatus":"unknown"},"notes":["CPU、内存与网络需询价确认"]}'::jsonb,
 'instance',1,100000,NULL,'hourly','GPU_HOUR',54790,1314970,NULL,'KAI_CARD_HOUR',2,'reference_only','2026-08-19','2026-09-19T03:59:59Z','inquiry_required','manual',NULL,NULL,'inquiry_confirmation_required','inquiry_then_quote',false,false,false,true,false,false,now(),now()),
('62000000-0000-4000-8000-000000000010','gpu-honghuan-b300-269gb-1',1,'supplier-shanghai-honghuan','hourly_gpu','B300 269GB · 单卡','B300',NULL,269,1,
 '{"gpu":{"model":"B300","formFactor":null,"advertisedMemoryGb":269,"environmentObservedMemoryGb":null,"countPerInstance":1},"cpu":{"description":null},"memory":{"description":null},"storage":{"description":"256GB"},"software":{"cudaVersion":null,"pythonVersion":null,"pytorchStatus":"unknown"},"notes":["规格为供应商标称，交付前复核","CPU、内存与网络需询价确认"]}'::jsonb,
 'instance',1,100000,NULL,'hourly','GPU_HOUR',30539,732934,NULL,'KAI_CARD_HOUR',2,'reference_only','2026-08-19','2026-09-19T03:59:59Z','inquiry_required','manual',NULL,NULL,'inquiry_confirmation_required','inquiry_then_quote',false,false,false,true,false,false,now(),now()),
('62000000-0000-4000-8000-000000000011','server-honghuan-b300-monthly-32plus',1,'supplier-shanghai-honghuan','contract_monthly','B300 整机长期租赁 · 32台起','B300',NULL,NULL,NULL,
 '{"gpu":{"model":"B300","formFactor":null,"advertisedMemoryGb":null,"environmentObservedMemoryGb":null,"countPerInstance":null},"cpu":{"description":null},"memory":{"description":null},"storage":{"description":null},"software":{"cudaVersion":null,"pythonVersion":null,"pytorchStatus":"unknown"},"notes":["32/64/128台起租","押一付一","预计4个月交付","香港验货可安排","具体GPU数量、CPU、内存与网络需询价确认"]}'::jsonb,
 'server',32,128,ARRAY[32,64,128],'monthly','SERVER_MONTH',NULL,NULL,41167665,'KAI_CARD_HOUR',2,'reference_only','2026-08-19','2026-09-19T03:59:59Z','inquiry_required','manual',4,'month','supplier_declared','inquiry_then_quote',false,false,false,true,false,true,now(),now())
ON CONFLICT(canonical_id) DO NOTHING;

INSERT INTO supplier_inquiry_catalog_source_prices(catalog_item_id,source_currency,source_hourly_minor,source_daily_minor,
  source_monthly_minor,listing_multiplier_millis,conversion_policy_version,settlement_fee_applied,evidence_sha256,
  evidence_storage_ref,evidence_status,raw_legal_terms)
VALUES
('62000000-0000-4000-8000-000000000001','CNY',1900,45600,NULL,1500,'KAI-SCH-1.002',false,'sha256:e3e7ac76dbe0d6b19b81babedbf591f6f5ad3068911f7d24a75c4bce585b55a9','evidence://supplier-shanghai-honghuan/quotes/2026-08-19-v1','user_provided_unverified',NULL),
('62000000-0000-4000-8000-000000000002','CNY',3600,86400,NULL,1500,'KAI-SCH-1.002',false,'sha256:e3e7ac76dbe0d6b19b81babedbf591f6f5ad3068911f7d24a75c4bce585b55a9','evidence://supplier-shanghai-honghuan/quotes/2026-08-19-v1','user_provided_unverified',NULL),
('62000000-0000-4000-8000-000000000003','CNY',6000,144000,NULL,1500,'KAI-SCH-1.002',false,'sha256:e3e7ac76dbe0d6b19b81babedbf591f6f5ad3068911f7d24a75c4bce585b55a9','evidence://supplier-shanghai-honghuan/quotes/2026-08-19-v1','user_provided_unverified',NULL),
('62000000-0000-4000-8000-000000000004','CNY',10900,261600,NULL,1500,'KAI-SCH-1.002',false,'sha256:e3e7ac76dbe0d6b19b81babedbf591f6f5ad3068911f7d24a75c4bce585b55a9','evidence://supplier-shanghai-honghuan/quotes/2026-08-19-v1','user_provided_unverified',NULL),
('62000000-0000-4000-8000-000000000005','CNY',5900,141600,NULL,1500,'KAI-SCH-1.002',false,'sha256:e3e7ac76dbe0d6b19b81babedbf591f6f5ad3068911f7d24a75c4bce585b55a9','evidence://supplier-shanghai-honghuan/quotes/2026-08-19-v1','user_provided_unverified',NULL),
('62000000-0000-4000-8000-000000000006','CNY',9200,220800,NULL,1500,'KAI-SCH-1.002',false,'sha256:e3e7ac76dbe0d6b19b81babedbf591f6f5ad3068911f7d24a75c4bce585b55a9','evidence://supplier-shanghai-honghuan/quotes/2026-08-19-v1','user_provided_unverified',NULL),
('62000000-0000-4000-8000-000000000007','CNY',9600,230400,NULL,1500,'KAI-SCH-1.002',false,'sha256:e3e7ac76dbe0d6b19b81babedbf591f6f5ad3068911f7d24a75c4bce585b55a9','evidence://supplier-shanghai-honghuan/quotes/2026-08-19-v1','user_provided_unverified',NULL),
('62000000-0000-4000-8000-000000000008','CNY',18600,446400,NULL,1500,'KAI-SCH-1.002',false,'sha256:e3e7ac76dbe0d6b19b81babedbf591f6f5ad3068911f7d24a75c4bce585b55a9','evidence://supplier-shanghai-honghuan/quotes/2026-08-19-v1','user_provided_unverified',NULL),
('62000000-0000-4000-8000-000000000009','CNY',36600,878400,NULL,1500,'KAI-SCH-1.002',false,'sha256:e3e7ac76dbe0d6b19b81babedbf591f6f5ad3068911f7d24a75c4bce585b55a9','evidence://supplier-shanghai-honghuan/quotes/2026-08-19-v1','user_provided_unverified',NULL),
('62000000-0000-4000-8000-000000000010','CNY',20400,489600,NULL,1500,'KAI-SCH-1.002',false,'sha256:e3e7ac76dbe0d6b19b81babedbf591f6f5ad3068911f7d24a75c4bce585b55a9','evidence://supplier-shanghai-honghuan/quotes/2026-08-19-v1','user_provided_unverified',NULL),
('62000000-0000-4000-8000-000000000011','CNY',NULL,NULL,27500000,1500,'KAI-SCH-1.002',false,'sha256:e3e7ac76dbe0d6b19b81babedbf591f6f5ad3068911f7d24a75c4bce585b55a9','evidence://supplier-shanghai-honghuan/quotes/2026-08-19-v1','user_provided_unverified',
 '{"legalReviewRequired":true,"supplierRawTerms":["1个月免责","5年闭口"],"executionStatus":"not_executable_pending_legal_review"}'::jsonb)
ON CONFLICT(catalog_item_id) DO NOTHING;

DO $$
DECLARE matching_items integer;
DECLARE matching_prices integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supplier_inquiry_catalog_sources WHERE supplier_id='supplier-shanghai-honghuan'
    AND legal_name='上海鸿欢网络科技有限公司' AND display_name='上海鸿欢'
    AND disclosure_status='platform_imported_unverified'
    AND logo_https_url='https://cloud.kai.com/assets/suppliers/shanghai-honghuan.jpg'
    AND logo_version='v1' AND logo_source_label='平台导入/主站已公开' AND logo_uploaded_by='platform-user-import'
    AND logo_source_sha256='sha256:db1ed9e4cddc31f4b6e641bbc9179443e5a5d251a31abe28109c3fa55f32a70f'
    AND logo_authorization_status='unverified' AND logo_provenance='user_provided'
    AND publication_directive_ref='platform-directive:2026-08-20:honghuan-formal-catalog-b1'
    AND supplier_authorization_evidence_ref IS NULL
    AND quote_evidence_sha256='sha256:e3e7ac76dbe0d6b19b81babedbf591f6f5ad3068911f7d24a75c4bce585b55a9'
    AND quote_evidence_storage_ref='evidence://supplier-shanghai-honghuan/quotes/2026-08-19-v1'
    AND quote_evidence_status='user_provided_unverified'
    AND source_kind='USER_PROVIDED_SUPPLIER_QUOTE' AND source_verification_status='unverified'
    AND source_observed_at='2026-08-19' AND valid_until='2026-09-19T03:59:59Z' AND evidence_complete=true) THEN
    RAISE EXCEPTION 'Honghuan supplier source conflicts with the approved seed snapshot';
  END IF;
  SELECT count(*) INTO matching_items FROM (VALUES
    ('gpu-honghuan-a100-sxm4-80gb-1','hourly_gpu','A100',1,2844::bigint,68263::bigint,NULL::bigint,false,'43d3b15da7ea6125be30cdb01ee98c28'),
    ('gpu-honghuan-a100-sxm4-80gb-2','hourly_gpu','A100',2,5389,129341,NULL,false,'db66e5e383aff127cef0a4749d1102d1'),
    ('gpu-honghuan-h100-sxm-80gb-1','hourly_gpu','H100',1,8982,215569,NULL,false,'3a1b65f04ee25919fc7ad2839c618768'),
    ('gpu-honghuan-h100-sxm-80gb-2','hourly_gpu','H100',2,16317,391617,NULL,false,'4cefb2195bb5e8009d2f2f45a3505c6f'),
    ('gpu-honghuan-h200-nvl-1','hourly_gpu','H200',1,8832,211976,NULL,false,'7cd4f3b38a6b1f8af7966912eb2b1c9f'),
    ('gpu-honghuan-h200-nvl-2','hourly_gpu','H200',2,13772,330539,NULL,false,'4cb5c9b97e2af5ee238ef5d7f715da9b'),
    ('gpu-honghuan-b200-179gb-1','hourly_gpu','B200',1,14371,344910,NULL,false,'6ecbc2391eab2c5342ceee1a19fcc819'),
    ('gpu-honghuan-b200-179gb-2','hourly_gpu','B200',2,27844,668263,NULL,false,'8946bc5598b45e1948ce817c83104298'),
    ('gpu-honghuan-b200-179gb-4','hourly_gpu','B200',4,54790,1314970,NULL,false,'6510dc990c70567b5b2ba240cfdf033f'),
    ('gpu-honghuan-b300-269gb-1','hourly_gpu','B300',1,30539,732934,NULL,false,'962c4b86a12b65792a2af9949e907942'),
    ('server-honghuan-b300-monthly-32plus','contract_monthly','B300',NULL,NULL,NULL,41167665,true,'135ff67bc633d5f77c9c757e7f6442eb')
  ) expected(canonical_id,catalog_kind,model,gpu_count,hourly_minor,daily_minor,monthly_minor,legal_review_required,snapshot_digest)
  JOIN supplier_inquiry_catalog_items item ON item.canonical_id=expected.canonical_id
    AND item.catalog_kind=expected.catalog_kind AND item.model=expected.model
    AND item.gpu_count IS NOT DISTINCT FROM expected.gpu_count
    AND item.reference_hourly_minor IS NOT DISTINCT FROM expected.hourly_minor
    AND item.reference_daily_minor IS NOT DISTINCT FROM expected.daily_minor
    AND item.reference_monthly_minor IS NOT DISTINCT FROM expected.monthly_minor
    AND item.legal_review_required=expected.legal_review_required AND item.version=1
    AND item.supplier_id='supplier-shanghai-honghuan' AND item.purchasable=false
    AND item.inventory_commitment=false AND item.order_creation=false AND item.inquiry_available=true
    AND item.simulation=false AND item.active=true AND item.source_observed_at='2026-08-19'
    AND item.valid_until='2026-09-19T03:59:59Z'
    AND md5(jsonb_build_object('id',item.id,'canonicalId',item.canonical_id,'version',item.version,
      'supplierId',item.supplier_id,'catalogKind',item.catalog_kind,'title',item.title,'model',item.model,
      'formFactor',item.form_factor,'memoryGb',item.memory_gb,'gpuCount',item.gpu_count,
      'specSnapshot',item.spec_snapshot,'quantityUnit',item.quantity_unit,'quantityMin',item.quantity_min,
      'quantityMax',item.quantity_max,'quantityAllowedValues',item.quantity_allowed_values,
      'billingMode',item.billing_mode,'billingUnit',item.billing_unit,'referenceHourlyMinor',item.reference_hourly_minor,
      'referenceDailyMinor',item.reference_daily_minor,'referenceMonthlyMinor',item.reference_monthly_minor,
      'referenceCurrency',item.reference_currency,'referencePrecision',item.reference_precision,
      'referenceStatus',item.reference_status,'availabilityStatus',item.availability_status,
      'deliveryMode',item.delivery_mode,'deliveryLeadTimeValue',item.delivery_lead_time_value,
      'deliveryLeadTimeUnit',item.delivery_lead_time_unit,'deliveryLeadTimeStatus',item.delivery_lead_time_status,
      'purchaseMode',item.purchase_mode,'purchasable',item.purchasable,'inventoryCommitment',item.inventory_commitment,
      'orderCreation',item.order_creation,'inquiryAvailable',item.inquiry_available,'simulation',item.simulation,
      'legalReviewRequired',item.legal_review_required,'active',item.active)::text)=expected.snapshot_digest;
  IF matching_items<>11 OR (SELECT count(*) FROM supplier_inquiry_catalog_items
      WHERE supplier_id='supplier-shanghai-honghuan')<>11 THEN
    RAISE EXCEPTION 'Honghuan catalog conflicts with the approved 11-item seed snapshot';
  END IF;
  SELECT count(*) INTO matching_prices FROM (VALUES
    ('gpu-honghuan-a100-sxm4-80gb-1','9bc92bdf59077a93c09e436141c54bb5'),
    ('gpu-honghuan-a100-sxm4-80gb-2','e6a091d09329a441666afc1ef6f52ab9'),
    ('gpu-honghuan-h100-sxm-80gb-1','5b08709d3a272e127c4071dbd06925a5'),
    ('gpu-honghuan-h100-sxm-80gb-2','4ffbcc97a92e3aa83c7292d32e326cdf'),
    ('gpu-honghuan-h200-nvl-1','00a1ae9d0aeff303e6d54cb803cadb8b'),
    ('gpu-honghuan-h200-nvl-2','ce462d062283904ba7f2866dddf52c42'),
    ('gpu-honghuan-b200-179gb-1','f36d5f9f1af3cede045078cb02bb652f'),
    ('gpu-honghuan-b200-179gb-2','bd84696f3648c3f876b7f8d51e16bff4'),
    ('gpu-honghuan-b200-179gb-4','0f1d81e7a3da80576a3d3bc25bcdc1a0'),
    ('gpu-honghuan-b300-269gb-1','e4451510a818f3a5076bbd6423e7adb4'),
    ('server-honghuan-b300-monthly-32plus','7978a5cd52a9beecbd879202c1c22fe9')
  ) expected(canonical_id,snapshot_digest)
  JOIN supplier_inquiry_catalog_items item ON item.canonical_id=expected.canonical_id
  JOIN supplier_inquiry_catalog_source_prices price ON price.catalog_item_id=item.id
    AND md5(jsonb_build_object('catalogItemId',price.catalog_item_id,'sourceCurrency',price.source_currency,
      'sourceHourlyMinor',price.source_hourly_minor,'sourceDailyMinor',price.source_daily_minor,
      'sourceMonthlyMinor',price.source_monthly_minor,'listingMultiplierMillis',price.listing_multiplier_millis,
      'conversionPolicyVersion',price.conversion_policy_version,'settlementFeeApplied',price.settlement_fee_applied,
      'evidenceSha256',price.evidence_sha256,'evidenceStorageRef',price.evidence_storage_ref,
      'evidenceStatus',price.evidence_status,'rawLegalTerms',price.raw_legal_terms)::text)=expected.snapshot_digest;
  IF matching_prices<>11 THEN RAISE EXCEPTION 'Honghuan source price evidence is incomplete or conflicting'; END IF;
END;
$$;
