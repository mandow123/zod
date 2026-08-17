-- A top-up reversal has two independent facts:
-- 1. KAI credits were recovered from the customer ledger;
-- 2. money was refunded/charged back by the external payment provider.
-- This service can prove only the first fact until a provider refund adapter is
-- connected.  Never label an internal credit recovery as a completed cash
-- refund.
CREATE TABLE kai_credit_topup_reversals (
  id uuid PRIMARY KEY,
  topup_id uuid NOT NULL REFERENCES kai_credit_topups(id),
  subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  provider text NOT NULL CHECK (provider IN ('alipay', 'wechat')),
  kind text NOT NULL CHECK (kind IN ('refund', 'chargeback')),
  provider_event_reference text NOT NULL CHECK (char_length(provider_event_reference) BETWEEN 8 AND 160),
  evidence_digest text NOT NULL CHECK (char_length(evidence_digest) BETWEEN 16 AND 160),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  credit_micros bigint NOT NULL CHECK (credit_micros > 0),
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN (
    'submitted', 'credit_recovered_external_unverified', 'rejected', 'cancelled'
  )),
  requested_by_operator_id uuid NOT NULL REFERENCES users(id),
  approved_by_operator_id uuid REFERENCES users(id),
  client_request_id text NOT NULL CHECK (char_length(client_request_id) BETWEEN 16 AND 120),
  payload_digest text NOT NULL CHECK (char_length(payload_digest) BETWEEN 16 AND 160),
  recovery_transaction_id uuid UNIQUE REFERENCES kai_credit_transactions(id),
  resolution_reason text,
  requested_at timestamptz NOT NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (requested_by_operator_id, client_request_id),
  UNIQUE (provider, provider_event_reference),
  CHECK (approved_by_operator_id IS NULL OR approved_by_operator_id <> requested_by_operator_id),
  CHECK ((status = 'submitted') = (resolved_at IS NULL)),
  CHECK ((status = 'credit_recovered_external_unverified') = (recovery_transaction_id IS NOT NULL)),
  CHECK ((status = 'credit_recovered_external_unverified') = (approved_by_operator_id IS NOT NULL))
);
CREATE INDEX kai_credit_topup_reversals_topup_created
  ON kai_credit_topup_reversals(topup_id, created_at DESC, id DESC);
CREATE INDEX kai_credit_topup_reversals_queue
  ON kai_credit_topup_reversals(requested_at, id) WHERE status = 'submitted';

ALTER TABLE kai_credit_topups ADD COLUMN reversed_credit_micros bigint NOT NULL DEFAULT 0
  CHECK (reversed_credit_micros >= 0 AND reversed_credit_micros <= credit_micros);
ALTER TABLE kai_credit_topups ADD COLUMN reversed_amount_cents bigint NOT NULL DEFAULT 0
  CHECK (reversed_amount_cents >= 0 AND reversed_amount_cents <= amount_cents);

CREATE TRIGGER kai_credit_topup_reversals_no_delete
  BEFORE DELETE ON kai_credit_topup_reversals FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE FUNCTION protect_kai_credit_topup_reversal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.topup_id <> OLD.topup_id OR NEW.subject_id <> OLD.subject_id
    OR NEW.provider <> OLD.provider OR NEW.kind <> OLD.kind
    OR NEW.provider_event_reference <> OLD.provider_event_reference
    OR NEW.evidence_digest <> OLD.evidence_digest OR NEW.amount_cents <> OLD.amount_cents
    OR NEW.credit_micros <> OLD.credit_micros
    OR NEW.requested_by_operator_id <> OLD.requested_by_operator_id
    OR NEW.client_request_id <> OLD.client_request_id OR NEW.payload_digest <> OLD.payload_digest
    OR NEW.requested_at <> OLD.requested_at OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'topup reversal identity is immutable';
  END IF;
  IF OLD.status <> 'submitted' OR NEW.status NOT IN (
    'credit_recovered_external_unverified', 'rejected', 'cancelled'
  ) THEN RAISE EXCEPTION 'invalid topup reversal transition'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER kai_credit_topup_reversals_guard BEFORE UPDATE ON kai_credit_topup_reversals
  FOR EACH ROW EXECUTE FUNCTION protect_kai_credit_topup_reversal();
