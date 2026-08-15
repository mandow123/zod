CREATE TABLE kai_credit_accounts (
  id uuid PRIMARY KEY,
  owner_kind text NOT NULL CHECK (owner_kind IN ('subject', 'platform')),
  subject_id uuid REFERENCES trading_subjects(id),
  code text NOT NULL UNIQUE CHECK (char_length(code) BETWEEN 3 AND 160),
  account_kind text NOT NULL CHECK (account_kind IN (
    'available', 'reserved', 'supplier_receivable',
    'platform_issuance', 'platform_clearing', 'platform_revenue'
  )),
  allow_negative boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_kind = 'subject') = (subject_id IS NOT NULL)),
  CHECK (
    (owner_kind = 'subject' AND account_kind IN ('available', 'reserved', 'supplier_receivable') AND allow_negative = false)
    OR (owner_kind = 'platform' AND account_kind IN ('platform_issuance', 'platform_clearing', 'platform_revenue'))
  )
);
CREATE UNIQUE INDEX kai_credit_accounts_subject_kind
  ON kai_credit_accounts(subject_id, account_kind) WHERE subject_id IS NOT NULL;

CREATE TABLE kai_credit_transactions (
  id uuid PRIMARY KEY,
  idempotency_owner text NOT NULL CHECK (char_length(idempotency_owner) BETWEEN 3 AND 160),
  scope text NOT NULL CHECK (char_length(scope) BETWEEN 3 AND 80),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 16 AND 120),
  payload_digest text NOT NULL CHECK (char_length(payload_digest) BETWEEN 16 AND 160),
  reference_type text NOT NULL CHECK (reference_type IN (
    'topup', 'order_reservation', 'order_release', 'order_capture', 'refund', 'settlement', 'adjustment'
  )),
  reference_id text,
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 240),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posted')),
  posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idempotency_owner, scope, idempotency_key),
  CHECK ((status = 'posted') = (posted_at IS NOT NULL))
);
CREATE INDEX kai_credit_transactions_reference
  ON kai_credit_transactions(reference_type, reference_id) WHERE reference_id IS NOT NULL;

CREATE TABLE kai_credit_entries (
  id uuid PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES kai_credit_transactions(id),
  account_id uuid NOT NULL REFERENCES kai_credit_accounts(id),
  amount_micros bigint NOT NULL CHECK (amount_micros <> 0),
  memo text NOT NULL CHECK (char_length(memo) BETWEEN 1 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transaction_id, account_id)
);
CREATE INDEX kai_credit_entries_account_time ON kai_credit_entries(account_id, created_at DESC, id DESC);

INSERT INTO kai_credit_accounts(id, owner_kind, subject_id, code, account_kind, allow_negative)
VALUES
  ('00000000-0000-4000-8000-000000000101', 'platform', NULL, 'platform:kai-credit:issuance', 'platform_issuance', true),
  ('00000000-0000-4000-8000-000000000102', 'platform', NULL, 'platform:kai-credit:clearing', 'platform_clearing', true),
  ('00000000-0000-4000-8000-000000000103', 'platform', NULL, 'platform:kai-credit:revenue', 'platform_revenue', false);

CREATE FUNCTION protect_kai_credit_account_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.owner_kind <> OLD.owner_kind OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
    OR NEW.code <> OLD.code OR NEW.account_kind <> OLD.account_kind OR NEW.allow_negative <> OLD.allow_negative
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'kai credit account identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION protect_kai_credit_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE transaction_status text;
DECLARE account_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'kai credit entries are immutable';
  END IF;
  SELECT status INTO transaction_status FROM kai_credit_transactions WHERE id = NEW.transaction_id FOR UPDATE;
  IF transaction_status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'kai credit entries can only be added to a pending transaction';
  END IF;
  SELECT status INTO account_status FROM kai_credit_accounts WHERE id = NEW.account_id FOR UPDATE;
  IF account_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'kai credit entries require an active account';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION post_kai_credit_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry_count integer;
DECLARE entry_total numeric;
DECLARE negative_account uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.posted_at IS NOT NULL THEN
      RAISE EXCEPTION 'kai credit transactions must be inserted as pending';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'posted' THEN
    RAISE EXCEPTION 'posted kai credit transactions are immutable';
  END IF;
  IF NEW.id <> OLD.id OR NEW.idempotency_owner <> OLD.idempotency_owner OR NEW.scope <> OLD.scope
    OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.payload_digest <> OLD.payload_digest
    OR NEW.reference_type <> OLD.reference_type OR NEW.reference_id IS DISTINCT FROM OLD.reference_id
    OR NEW.description <> OLD.description OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'kai credit transaction identity is immutable';
  END IF;
  IF NEW.status <> 'posted' THEN RETURN NEW; END IF;

  PERFORM a.id FROM kai_credit_accounts a
    JOIN kai_credit_entries e ON e.account_id = a.id
    WHERE e.transaction_id = NEW.id ORDER BY a.id FOR UPDATE OF a;

  SELECT count(*), COALESCE(sum(amount_micros), 0)
    INTO entry_count, entry_total FROM kai_credit_entries WHERE transaction_id = NEW.id;
  IF entry_count < 2 OR entry_total <> 0 THEN
    RAISE EXCEPTION 'kai credit transaction must contain at least two balanced entries';
  END IF;

  SELECT a.id INTO negative_account
    FROM kai_credit_accounts a
    JOIN kai_credit_entries current_entry ON current_entry.account_id = a.id AND current_entry.transaction_id = NEW.id
    WHERE a.allow_negative = false AND (
      COALESCE((SELECT sum(e.amount_micros) FROM kai_credit_entries e
        JOIN kai_credit_transactions t ON t.id = e.transaction_id
        WHERE e.account_id = a.id AND t.status = 'posted'), 0)
      + current_entry.amount_micros
    ) < 0
    LIMIT 1;
  IF negative_account IS NOT NULL THEN
    RAISE EXCEPTION 'kai credit account % cannot become negative', negative_account;
  END IF;

  NEW.posted_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER kai_credit_accounts_identity_immutable
  BEFORE UPDATE ON kai_credit_accounts FOR EACH ROW EXECUTE FUNCTION protect_kai_credit_account_identity();
CREATE TRIGGER kai_credit_accounts_no_delete
  BEFORE DELETE ON kai_credit_accounts FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER kai_credit_entries_guard
  BEFORE INSERT OR UPDATE OR DELETE ON kai_credit_entries FOR EACH ROW EXECUTE FUNCTION protect_kai_credit_entry();
CREATE TRIGGER kai_credit_transactions_post
  BEFORE INSERT OR UPDATE ON kai_credit_transactions FOR EACH ROW EXECUTE FUNCTION post_kai_credit_transaction();
CREATE TRIGGER kai_credit_transactions_no_delete
  BEFORE DELETE ON kai_credit_transactions FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
