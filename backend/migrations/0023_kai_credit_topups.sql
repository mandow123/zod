CREATE TABLE kai_credit_topups (
  id uuid PRIMARY KEY,
  subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  client_request_id text NOT NULL CHECK (char_length(client_request_id) BETWEEN 16 AND 120),
  payload_digest text NOT NULL CHECK (char_length(payload_digest) BETWEEN 16 AND 160),
  provider text NOT NULL CHECK (provider IN ('alipay', 'wechat')),
  channel text NOT NULL CHECK (channel = 'app'),
  provider_reference text NOT NULL,
  provider_payment_id text,
  provider_transaction_id text,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  credit_micros bigint NOT NULL CHECK (credit_micros > 0),
  conversion_cny_micros_per_credit bigint NOT NULL CHECK (conversion_cny_micros_per_credit = 1002000),
  status text NOT NULL DEFAULT 'created' CHECK (status IN (
    'created', 'pending', 'succeeded', 'failed', 'expired', 'cancelled', 'manual_review'
  )),
  checkout_payload text,
  expires_at timestamptz NOT NULL,
  succeeded_at timestamptz,
  reconciliation_attempts integer NOT NULL DEFAULT 0 CHECK (reconciliation_attempts >= 0),
  next_reconcile_at timestamptz NOT NULL DEFAULT now(),
  reconciliation_locked_at timestamptz,
  last_reconciled_at timestamptz,
  last_provider_status text,
  last_reconciliation_error text,
  reconciliation_dead_lettered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_id, client_request_id),
  UNIQUE (provider, provider_reference),
  CHECK ((status = 'succeeded') = (succeeded_at IS NOT NULL)),
  CHECK (status <> 'pending' OR checkout_payload IS NOT NULL)
);
CREATE UNIQUE INDEX kai_credit_topups_provider_transaction
  ON kai_credit_topups(provider, provider_transaction_id) WHERE provider_transaction_id IS NOT NULL;
CREATE INDEX kai_credit_topups_subject_created ON kai_credit_topups(subject_id, created_at DESC);
CREATE INDEX kai_credit_topups_reconciliation_queue
  ON kai_credit_topups(next_reconcile_at, created_at)
  WHERE status = 'pending' AND reconciliation_dead_lettered_at IS NULL;

CREATE TABLE kai_credit_topup_events (
  id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('alipay', 'wechat')),
  provider_event_id text NOT NULL,
  topup_id uuid REFERENCES kai_credit_topups(id),
  provider_transaction_id text,
  status text NOT NULL CHECK (status IN ('succeeded', 'failed')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL,
  payload_digest text NOT NULL,
  normalized_payload jsonb NOT NULL,
  processing_result text NOT NULL CHECK (processing_result IN (
    'succeeded', 'failed', 'duplicate', 'unknown_reference', 'amount_or_currency_mismatch',
    'provider_transaction_conflict', 'manual_review'
  )),
  processed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);
CREATE TABLE kai_credit_topup_provider_claims (
  provider text NOT NULL CHECK (provider IN ('alipay', 'wechat')),
  provider_transaction_id text NOT NULL,
  topup_id uuid NOT NULL UNIQUE REFERENCES kai_credit_topups(id),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_transaction_id)
);

CREATE TRIGGER kai_credit_topups_updated_at
  BEFORE UPDATE ON kai_credit_topups FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER kai_credit_topup_events_immutable
  BEFORE UPDATE OR DELETE ON kai_credit_topup_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER kai_credit_topup_provider_claims_immutable
  BEFORE UPDATE OR DELETE ON kai_credit_topup_provider_claims FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
