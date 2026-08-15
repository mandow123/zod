ALTER TABLE kai_credit_accounts
  DROP CONSTRAINT kai_credit_accounts_account_kind_check,
  ADD CONSTRAINT kai_credit_accounts_account_kind_check CHECK (account_kind IN (
    'available', 'reserved', 'supplier_receivable', 'payout_frozen',
    'platform_issuance', 'platform_clearing', 'platform_revenue'
  ));

ALTER TABLE kai_credit_accounts
  DROP CONSTRAINT kai_credit_accounts_check,
  DROP CONSTRAINT kai_credit_accounts_check1,
  ADD CONSTRAINT kai_credit_accounts_owner_subject_check CHECK ((owner_kind = 'subject') = (subject_id IS NOT NULL)),
  ADD CONSTRAINT kai_credit_accounts_kind_owner_check CHECK (
    (owner_kind = 'subject' AND account_kind IN ('available', 'reserved', 'supplier_receivable', 'payout_frozen')
      AND allow_negative = false)
    OR (owner_kind = 'platform' AND account_kind IN ('platform_issuance', 'platform_clearing', 'platform_revenue'))
  );

ALTER TABLE kai_credit_transactions
  DROP CONSTRAINT kai_credit_transactions_reference_type_check,
  ADD CONSTRAINT kai_credit_transactions_reference_type_check CHECK (reference_type IN (
    'topup', 'order_reservation', 'order_release', 'order_capture', 'refund', 'settlement', 'payout', 'adjustment'
    , 'service_fee', 'service_fee_reversal'
  ));

CREATE TABLE kai_credit_payout_profiles (
  subject_id uuid PRIMARY KEY REFERENCES trading_subjects(id),
  status text NOT NULL DEFAULT 'pending_activation' CHECK (status IN ('pending_activation', 'active', 'suspended')),
  legal_entity_digest text CHECK (legal_entity_digest IS NULL OR char_length(legal_entity_digest) BETWEEN 16 AND 160),
  recipient_reference text CHECK (recipient_reference IS NULL OR char_length(recipient_reference) BETWEEN 8 AND 160),
  activated_by_user_id uuid REFERENCES users(id),
  activated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'active') = (
    legal_entity_digest IS NOT NULL AND recipient_reference IS NOT NULL
    AND activated_by_user_id IS NOT NULL AND activated_at IS NOT NULL
  ))
);

CREATE TABLE kai_credit_payout_requests (
  id uuid PRIMARY KEY,
  payout_number text NOT NULL UNIQUE CHECK (char_length(payout_number) BETWEEN 12 AND 40),
  subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  client_request_id text NOT NULL CHECK (char_length(client_request_id) BETWEEN 16 AND 120),
  payload_digest text NOT NULL CHECK (char_length(payload_digest) BETWEEN 16 AND 160),
  status text NOT NULL CHECK (status IN (
    'submitted', 'reviewing', 'paying', 'succeeded', 'failed', 'rejected', 'cancelled'
  )),
  credit_micros bigint NOT NULL CHECK (credit_micros > 0),
  conversion_cny_micros_per_credit bigint NOT NULL CHECK (conversion_cny_micros_per_credit = 1002000),
  cny_micros bigint NOT NULL CHECK (cny_micros > 0),
  payment_amount_cents bigint NOT NULL CHECK (payment_amount_cents > 0),
  available_before_micros bigint NOT NULL CHECK (available_before_micros >= 0),
  available_after_micros bigint NOT NULL CHECK (available_after_micros >= 0),
  frozen_before_micros bigint NOT NULL CHECK (frozen_before_micros >= 0),
  frozen_after_micros bigint NOT NULL CHECK (frozen_after_micros >= 0),
  resolution_available_before_micros bigint,
  resolution_available_after_micros bigint,
  resolution_frozen_before_micros bigint,
  resolution_frozen_after_micros bigint,
  payout_account_id uuid NOT NULL REFERENCES kai_credit_accounts(id),
  freeze_transaction_id uuid NOT NULL UNIQUE REFERENCES kai_credit_transactions(id),
  resolution_transaction_id uuid UNIQUE REFERENCES kai_credit_transactions(id),
  recipient_reference text NOT NULL CHECK (char_length(recipient_reference) BETWEEN 8 AND 160),
  company_payment_reference text UNIQUE,
  company_payment_flow_digest text UNIQUE,
  company_payment_amount_cents bigint CHECK (company_payment_amount_cents > 0),
  failure_code text,
  resolution_reason text,
  reviewed_by_user_id uuid REFERENCES users(id),
  reviewed_at timestamptz,
  paying_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_id, client_request_id),
  CHECK (cny_micros = (credit_micros * conversion_cny_micros_per_credit + 500000) / 1000000),
  CHECK (payment_amount_cents = (cny_micros + 5000) / 10000),
  CHECK (available_after_micros = available_before_micros - credit_micros),
  CHECK (frozen_after_micros = frozen_before_micros + credit_micros),
  CHECK ((status IN ('succeeded', 'failed', 'rejected', 'cancelled')) = (resolved_at IS NOT NULL)),
  CHECK ((status IN ('succeeded', 'failed', 'rejected', 'cancelled')) = (resolution_transaction_id IS NOT NULL)),
  CHECK ((status IN ('succeeded', 'failed', 'rejected', 'cancelled')) = (
    resolution_available_before_micros IS NOT NULL AND resolution_available_after_micros IS NOT NULL
    AND resolution_frozen_before_micros IS NOT NULL AND resolution_frozen_after_micros IS NOT NULL
  )),
  CHECK ((status = 'succeeded') = (
    company_payment_reference IS NOT NULL AND company_payment_flow_digest IS NOT NULL
    AND company_payment_amount_cents = payment_amount_cents
  )),
  CHECK (status = 'succeeded' OR (company_payment_reference IS NULL AND company_payment_flow_digest IS NULL
    AND company_payment_amount_cents IS NULL))
);
CREATE INDEX kai_credit_payout_requests_subject_time
  ON kai_credit_payout_requests(subject_id, created_at DESC, id DESC);
CREATE INDEX kai_credit_payout_requests_queue
  ON kai_credit_payout_requests(status, created_at, id)
  WHERE status IN ('submitted', 'reviewing', 'paying');

CREATE TABLE kai_credit_payout_actions (
  actor_id uuid NOT NULL REFERENCES users(id),
  client_request_id text NOT NULL CHECK (char_length(client_request_id) BETWEEN 16 AND 120),
  payout_id uuid NOT NULL REFERENCES kai_credit_payout_requests(id),
  action text NOT NULL CHECK (action IN ('review', 'pay', 'succeed', 'fail', 'reject', 'cancel')),
  payload_digest text NOT NULL CHECK (char_length(payload_digest) BETWEEN 16 AND 160),
  result_status text NOT NULL CHECK (result_status IN (
    'reviewing', 'paying', 'succeeded', 'failed', 'rejected', 'cancelled', 'invalid_state'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, client_request_id)
);

CREATE TRIGGER kai_credit_payout_profiles_updated_at
  BEFORE UPDATE ON kai_credit_payout_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER kai_credit_payout_requests_updated_at
  BEFORE UPDATE ON kai_credit_payout_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION protect_kai_credit_payout_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.payout_number <> OLD.payout_number OR NEW.subject_id <> OLD.subject_id
    OR NEW.requested_by_user_id <> OLD.requested_by_user_id OR NEW.client_request_id <> OLD.client_request_id
    OR NEW.payload_digest <> OLD.payload_digest OR NEW.credit_micros <> OLD.credit_micros
    OR NEW.conversion_cny_micros_per_credit <> OLD.conversion_cny_micros_per_credit
    OR NEW.cny_micros <> OLD.cny_micros OR NEW.payment_amount_cents <> OLD.payment_amount_cents
    OR NEW.available_before_micros <> OLD.available_before_micros
    OR NEW.available_after_micros <> OLD.available_after_micros
    OR NEW.frozen_before_micros <> OLD.frozen_before_micros
    OR NEW.frozen_after_micros <> OLD.frozen_after_micros
    OR NEW.payout_account_id <> OLD.payout_account_id OR NEW.freeze_transaction_id <> OLD.freeze_transaction_id
    OR NEW.recipient_reference <> OLD.recipient_reference OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'kai credit payout identity is immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'submitted' AND NEW.status IN ('reviewing', 'cancelled'))
    OR (OLD.status = 'reviewing' AND NEW.status IN ('paying', 'rejected'))
    OR (OLD.status = 'paying' AND NEW.status IN ('succeeded', 'failed'))
  ) THEN RAISE EXCEPTION 'invalid kai credit payout transition'; END IF;
  IF OLD.resolved_at IS NOT NULL THEN RAISE EXCEPTION 'resolved kai credit payout is immutable'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER kai_credit_payout_requests_guard
  BEFORE UPDATE ON kai_credit_payout_requests FOR EACH ROW EXECUTE FUNCTION protect_kai_credit_payout_identity();
CREATE TRIGGER kai_credit_payout_requests_no_delete
  BEFORE DELETE ON kai_credit_payout_requests FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER kai_credit_payout_actions_immutable
  BEFORE UPDATE OR DELETE ON kai_credit_payout_actions FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
