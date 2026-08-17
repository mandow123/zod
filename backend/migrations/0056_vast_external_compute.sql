CREATE TABLE vast_external_quotes (
  id uuid PRIMARY KEY,
  buyer_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  provider_source text NOT NULL CHECK (provider_source = 'vast_ai'),
  provider_offer_id bigint NOT NULL CHECK (provider_offer_id > 0),
  configuration jsonb NOT NULL,
  provider_snapshot jsonb NOT NULL,
  provider_cost_micros_per_hour bigint NOT NULL CHECK (provider_cost_micros_per_hour > 0),
  credit_micros_per_hour bigint NOT NULL CHECK (credit_micros_per_hour > 0 AND credit_micros_per_hour % 10000 = 0),
  duration_hours integer NOT NULL CHECK (duration_hours BETWEEN 1 AND 720),
  total_credit_micros bigint NOT NULL CHECK (total_credit_micros > 0 AND total_credit_micros % 10000 = 0),
  pricing_policy_version text NOT NULL CHECK (char_length(pricing_policy_version) BETWEEN 1 AND 80),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','consumed','stale','expired')),
  quoted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > quoted_at),
  CHECK (total_credit_micros = credit_micros_per_hour * duration_hours)
);
CREATE INDEX vast_external_quotes_subject_expiry
  ON vast_external_quotes(buyer_subject_id,status,expires_at DESC);

CREATE TABLE vast_external_orders (
  id uuid PRIMARY KEY,
  order_number text NOT NULL UNIQUE CHECK (char_length(order_number) BETWEEN 12 AND 40),
  buyer_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  quote_id uuid NOT NULL UNIQUE REFERENCES vast_external_quotes(id),
  client_request_id text NOT NULL CHECK (char_length(client_request_id) BETWEEN 16 AND 120),
  payload_digest text NOT NULL CHECK (char_length(payload_digest) BETWEEN 16 AND 160),
  provider_source text NOT NULL CHECK (provider_source = 'vast_ai'),
  provider_offer_id bigint NOT NULL CHECK (provider_offer_id > 0),
  provider_request_key uuid NOT NULL UNIQUE,
  provider_contract_id bigint UNIQUE CHECK (provider_contract_id IS NULL OR provider_contract_id > 0),
  configuration jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('reserved','pending_reconciliation','provisioning','failed')),
  total_credit_micros bigint NOT NULL CHECK (total_credit_micros > 0 AND total_credit_micros % 10000 = 0),
  reservation_transaction_id uuid NOT NULL UNIQUE REFERENCES kai_credit_transactions(id),
  capture_transaction_id uuid UNIQUE REFERENCES kai_credit_transactions(id),
  release_transaction_id uuid UNIQUE REFERENCES kai_credit_transactions(id),
  failure_code text,
  reconciliation_deadline_at timestamptz NOT NULL,
  provisioning_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (buyer_subject_id,client_request_id),
  CHECK ((status = 'provisioning') = (provider_contract_id IS NOT NULL AND provisioning_at IS NOT NULL
    AND capture_transaction_id IS NOT NULL)),
  CHECK ((status = 'failed') = (failed_at IS NOT NULL AND release_transaction_id IS NOT NULL)),
  CHECK (NOT (capture_transaction_id IS NOT NULL AND release_transaction_id IS NOT NULL)),
  CHECK (status <> 'failed' OR failure_code IS NOT NULL)
);
CREATE INDEX vast_external_orders_subject_created
  ON vast_external_orders(buyer_subject_id,created_at DESC);
CREATE INDEX vast_external_orders_reconciliation
  ON vast_external_orders(status,reconciliation_deadline_at)
  WHERE status = 'pending_reconciliation';

CREATE TRIGGER vast_external_orders_updated_at
  BEFORE UPDATE ON vast_external_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION protect_vast_external_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Vast external orders cannot be deleted'; END IF;
  IF NEW.id <> OLD.id OR NEW.order_number <> OLD.order_number
    OR NEW.buyer_subject_id <> OLD.buyer_subject_id OR NEW.created_by_user_id <> OLD.created_by_user_id
    OR NEW.quote_id <> OLD.quote_id OR NEW.client_request_id <> OLD.client_request_id
    OR NEW.payload_digest <> OLD.payload_digest OR NEW.provider_source <> OLD.provider_source
    OR NEW.provider_offer_id <> OLD.provider_offer_id OR NEW.provider_request_key <> OLD.provider_request_key
    OR NEW.configuration <> OLD.configuration OR NEW.total_credit_micros <> OLD.total_credit_micros
    OR NEW.reservation_transaction_id <> OLD.reservation_transaction_id
    OR NEW.reconciliation_deadline_at <> OLD.reconciliation_deadline_at OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Vast external order identity is immutable';
  END IF;
  IF OLD.status = 'failed' THEN RAISE EXCEPTION 'failed Vast external order is immutable'; END IF;
  IF OLD.provider_contract_id IS NOT NULL AND NEW.provider_contract_id IS DISTINCT FROM OLD.provider_contract_id THEN
    RAISE EXCEPTION 'Vast provider contract is immutable';
  END IF;
  IF OLD.capture_transaction_id IS NOT NULL
    AND NEW.capture_transaction_id IS DISTINCT FROM OLD.capture_transaction_id THEN
    RAISE EXCEPTION 'Vast capture transaction is immutable';
  END IF;
  IF OLD.status = 'provisioning' AND NEW.status <> 'provisioning' THEN
    RAISE EXCEPTION 'provisioning Vast external order cannot return to pre-provision state';
  END IF;
  IF OLD.status IN ('reserved','pending_reconciliation')
    AND NEW.status NOT IN ('reserved','pending_reconciliation','provisioning','failed') THEN
    RAISE EXCEPTION 'invalid Vast external order transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER vast_external_orders_guard
  BEFORE UPDATE OR DELETE ON vast_external_orders FOR EACH ROW EXECUTE FUNCTION protect_vast_external_order();
