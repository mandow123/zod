-- Creator commissions use an independent sub-ledger. They enter the user's
-- KAI card-hour wallet only through an explicit, audited transfer transaction.
CREATE TABLE creator_referral_links (
  id uuid PRIMARY KEY,
  creator_user_id uuid NOT NULL REFERENCES users(id),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{8,24}$'),
  client_request_id text NOT NULL CHECK (char_length(client_request_id) BETWEEN 16 AND 120),
  payload_digest text NOT NULL CHECK (char_length(payload_digest) BETWEEN 16 AND 160),
  policy_version text NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 80),
  commission_basis_points integer NOT NULL CHECK (commission_basis_points BETWEEN 1 AND 5000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (creator_user_id,client_request_id)
);

CREATE TABLE creator_referral_attributions (
  id uuid PRIMARY KEY,
  buyer_user_id uuid NOT NULL REFERENCES users(id),
  buyer_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  link_id uuid NOT NULL REFERENCES creator_referral_links(id),
  creator_user_id uuid NOT NULL REFERENCES users(id),
  provider_source text NOT NULL CHECK (provider_source IN ('first_party','douyin','tiktok')),
  provider_event_id text NOT NULL CHECK (char_length(provider_event_id) BETWEEN 8 AND 160),
  payload_digest text NOT NULL CHECK (char_length(payload_digest) BETWEEN 16 AND 160),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','replaced','revoked','expired')),
  attributed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (buyer_user_id <> creator_user_id),
  CHECK (expires_at > attributed_at),
  UNIQUE (provider_source,provider_event_id)
);
CREATE UNIQUE INDEX creator_referral_active_subject
  ON creator_referral_attributions(buyer_subject_id) WHERE status='active';

CREATE TABLE creator_commission_accounts (
  id uuid PRIMARY KEY,
  owner_kind text NOT NULL CHECK (owner_kind IN ('creator','platform')),
  creator_user_id uuid REFERENCES users(id),
  code text NOT NULL UNIQUE CHECK (char_length(code) BETWEEN 3 AND 160),
  account_kind text NOT NULL CHECK (account_kind IN ('pending','available','transferred','clearing')),
  allow_negative boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_kind='creator')=(creator_user_id IS NOT NULL)),
  CHECK ((owner_kind='platform')=(account_kind='clearing'))
);
CREATE UNIQUE INDEX creator_commission_creator_account
  ON creator_commission_accounts(creator_user_id,account_kind) WHERE creator_user_id IS NOT NULL;

INSERT INTO creator_commission_accounts(id,owner_kind,creator_user_id,code,account_kind,allow_negative)
VALUES('00000000-0000-4000-8000-000000000201','platform',NULL,'creator-commission:platform:clearing','clearing',true);

CREATE TABLE creator_commission_transactions (
  id uuid PRIMARY KEY,
  idempotency_owner text NOT NULL CHECK (char_length(idempotency_owner) BETWEEN 3 AND 160),
  scope text NOT NULL CHECK (scope IN ('COMMISSION_EARN','COMMISSION_MATURE','COMMISSION_REVERSE','COMMISSION_TRANSFER')),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 16 AND 160),
  payload_digest text NOT NULL CHECK (char_length(payload_digest) BETWEEN 16 AND 160),
  association_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','posted')),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz,
  UNIQUE(idempotency_owner,scope,idempotency_key),
  CHECK ((status='posted')=(posted_at IS NOT NULL))
);

CREATE TABLE creator_commission_entries (
  id uuid PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES creator_commission_transactions(id),
  account_id uuid NOT NULL REFERENCES creator_commission_accounts(id),
  amount_micros bigint NOT NULL CHECK (amount_micros <> 0 AND amount_micros % 10000 = 0),
  memo text NOT NULL CHECK (char_length(memo) BETWEEN 1 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(transaction_id,account_id)
);
CREATE INDEX creator_commission_entries_account ON creator_commission_entries(account_id,created_at DESC);

CREATE TABLE creator_commission_orders (
  id uuid PRIMARY KEY,
  order_kind text NOT NULL CHECK (order_kind IN ('credit_order','device_order','vast_order')),
  order_id uuid NOT NULL,
  attribution_id uuid NOT NULL REFERENCES creator_referral_attributions(id),
  creator_user_id uuid NOT NULL REFERENCES users(id),
  buyer_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  gross_credit_micros bigint NOT NULL CHECK (gross_credit_micros > 0 AND gross_credit_micros % 10000 = 0),
  commission_credit_micros bigint NOT NULL CHECK (commission_credit_micros > 0 AND commission_credit_micros % 10000 = 0),
  policy_version text NOT NULL,
  status text NOT NULL DEFAULT 'attributed' CHECK (status IN (
    'attributed','refund_observation','pending','available','reversed','transferred'
  )),
  completion_event_key text,
  reversal_event_key text,
  completed_at timestamptz,
  observation_ends_at timestamptz,
  available_at timestamptz,
  reversed_at timestamptz,
  transferred_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(order_kind,order_id),
  CHECK (status <> 'attributed' OR completed_at IS NULL),
  CHECK (status NOT IN ('refund_observation','pending','available','transferred') OR completed_at IS NOT NULL),
  CHECK (status <> 'refund_observation' OR (observation_ends_at IS NOT NULL AND available_at IS NULL)),
  CHECK ((status IN ('available','transferred'))=(available_at IS NOT NULL)),
  CHECK ((status='reversed')=(reversed_at IS NOT NULL)),
  CHECK ((status='transferred')=(transferred_at IS NOT NULL))
);
ALTER TABLE creator_commission_transactions ADD CONSTRAINT creator_commission_transaction_association_fk
  FOREIGN KEY(association_id) REFERENCES creator_commission_orders(id);
CREATE INDEX creator_commission_orders_creator_status
  ON creator_commission_orders(creator_user_id,status,updated_at DESC);
CREATE INDEX creator_commission_orders_observation
  ON creator_commission_orders(status,observation_ends_at) WHERE status='refund_observation';

CREATE TABLE creator_commission_transfers (
  id uuid PRIMARY KEY,
  creator_user_id uuid NOT NULL REFERENCES users(id),
  target_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  client_request_id text NOT NULL CHECK (char_length(client_request_id) BETWEEN 16 AND 120),
  payload_digest text NOT NULL CHECK (char_length(payload_digest) BETWEEN 16 AND 160),
  credit_micros bigint NOT NULL CHECK (credit_micros > 0 AND credit_micros % 10000 = 0),
  commission_transaction_id uuid NOT NULL UNIQUE REFERENCES creator_commission_transactions(id),
  kai_credit_transaction_id uuid NOT NULL UNIQUE REFERENCES kai_credit_transactions(id),
  status text NOT NULL CHECK (status='succeeded'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(creator_user_id,client_request_id)
);

CREATE TABLE creator_reward_events (
  id uuid PRIMARY KEY,
  creator_user_id uuid NOT NULL REFERENCES users(id),
  transfer_id uuid NOT NULL UNIQUE REFERENCES creator_commission_transfers(id),
  credit_micros bigint NOT NULL CHECK (credit_micros > 0 AND credit_micros % 10000 = 0),
  status text NOT NULL DEFAULT 'unconsumed' CHECK (status IN ('unconsumed','consumed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  CHECK ((status='consumed')=(consumed_at IS NOT NULL))
);
CREATE INDEX creator_reward_events_unconsumed
  ON creator_reward_events(creator_user_id,created_at) WHERE status='unconsumed';

CREATE TABLE creator_commission_audit_events (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  creator_user_id uuid REFERENCES users(id),
  actor_user_id uuid REFERENCES users(id),
  association_id uuid REFERENCES creator_commission_orders(id),
  attribution_id uuid REFERENCES creator_referral_attributions(id),
  idempotency_key text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX creator_commission_audit_idempotency
  ON creator_commission_audit_events(event_type,idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TRIGGER creator_commission_orders_updated_at
  BEFORE UPDATE ON creator_commission_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE FUNCTION protect_creator_commission_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.owner_kind<>OLD.owner_kind OR NEW.creator_user_id IS DISTINCT FROM OLD.creator_user_id
    OR NEW.code<>OLD.code OR NEW.account_kind<>OLD.account_kind OR NEW.allow_negative<>OLD.allow_negative
    OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'creator commission account identity is immutable'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION protect_creator_commission_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE transaction_status text;
DECLARE account_status text;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'creator commission entries are immutable'; END IF;
  SELECT status INTO transaction_status FROM creator_commission_transactions WHERE id=NEW.transaction_id FOR UPDATE;
  IF transaction_status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'creator commission entries require a pending transaction';
  END IF;
  SELECT status INTO account_status FROM creator_commission_accounts WHERE id=NEW.account_id FOR UPDATE;
  IF account_status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'creator commission entries require an active account'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION post_creator_commission_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry_count integer;
DECLARE entry_total numeric;
DECLARE negative_account uuid;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'pending' OR NEW.posted_at IS NOT NULL THEN
      RAISE EXCEPTION 'creator commission transactions must be inserted as pending';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='posted' THEN RAISE EXCEPTION 'posted creator commission transactions are immutable'; END IF;
  IF NEW.id<>OLD.id OR NEW.idempotency_owner<>OLD.idempotency_owner OR NEW.scope<>OLD.scope
    OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.payload_digest<>OLD.payload_digest
    OR NEW.association_id IS DISTINCT FROM OLD.association_id OR NEW.description<>OLD.description
    OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'creator commission transaction identity is immutable'; END IF;
  IF NEW.status<>'posted' THEN RETURN NEW; END IF;

  PERFORM a.id FROM creator_commission_accounts a JOIN creator_commission_entries e ON e.account_id=a.id
    WHERE e.transaction_id=NEW.id ORDER BY a.id FOR UPDATE OF a;
  SELECT count(*),COALESCE(sum(amount_micros),0) INTO entry_count,entry_total
    FROM creator_commission_entries WHERE transaction_id=NEW.id;
  IF entry_count<2 OR entry_total<>0 THEN
    RAISE EXCEPTION 'creator commission transaction must contain balanced entries';
  END IF;
  SELECT a.id INTO negative_account FROM creator_commission_accounts a
    JOIN creator_commission_entries current_entry ON current_entry.account_id=a.id AND current_entry.transaction_id=NEW.id
    WHERE a.allow_negative=false AND (COALESCE((SELECT sum(e.amount_micros) FROM creator_commission_entries e
      JOIN creator_commission_transactions t ON t.id=e.transaction_id
      WHERE e.account_id=a.id AND t.status='posted'),0)+current_entry.amount_micros)<0 LIMIT 1;
  IF negative_account IS NOT NULL THEN RAISE EXCEPTION 'creator commission account cannot become negative'; END IF;
  NEW.posted_at=COALESCE(NEW.posted_at,now());
  RETURN NEW;
END;
$$;

CREATE FUNCTION consume_creator_reward_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'creator reward events cannot be deleted'; END IF;
  IF NEW.id<>OLD.id OR NEW.creator_user_id<>OLD.creator_user_id OR NEW.transfer_id<>OLD.transfer_id
    OR NEW.credit_micros<>OLD.credit_micros OR NEW.created_at<>OLD.created_at
    OR OLD.status<>'unconsumed' OR NEW.status<>'consumed' OR NEW.consumed_at IS NULL THEN
    RAISE EXCEPTION 'invalid creator reward event mutation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER creator_commission_accounts_identity BEFORE UPDATE ON creator_commission_accounts
  FOR EACH ROW EXECUTE FUNCTION protect_creator_commission_account();
CREATE TRIGGER creator_commission_accounts_no_delete BEFORE DELETE ON creator_commission_accounts
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER creator_commission_transactions_post BEFORE INSERT OR UPDATE ON creator_commission_transactions
  FOR EACH ROW EXECUTE FUNCTION post_creator_commission_transaction();
CREATE TRIGGER creator_commission_transactions_no_delete BEFORE DELETE ON creator_commission_transactions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER creator_commission_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON creator_commission_entries
  FOR EACH ROW EXECUTE FUNCTION protect_creator_commission_entry();
CREATE TRIGGER creator_commission_transfers_immutable BEFORE UPDATE OR DELETE ON creator_commission_transfers
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER creator_reward_events_guard BEFORE UPDATE OR DELETE ON creator_reward_events
  FOR EACH ROW EXECUTE FUNCTION consume_creator_reward_event();
CREATE TRIGGER creator_commission_audit_immutable
  BEFORE UPDATE OR DELETE ON creator_commission_audit_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
