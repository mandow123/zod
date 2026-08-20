-- Streamer commissions and ordinary-user invitations are separate domains.
-- The legacy creator tables from 0057 are intentionally neither copied nor reused.

CREATE TABLE streamer_partners (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES users(id),
  subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  beneficial_owner_digest text NOT NULL CHECK (char_length(beneficial_owner_digest) BETWEEN 16 AND 160),
  status text NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','approved','suspended','rejected')),
  applied_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK ((status='applied')=(reviewed_at IS NULL)),
  CHECK ((reviewed_at IS NULL)=(reviewed_by_user_id IS NULL))
);

CREATE TABLE streamer_promotion_codes (
  id uuid PRIMARY KEY,
  partner_id uuid NOT NULL REFERENCES streamer_partners(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  campaign_id uuid NOT NULL,
  product_kind text NOT NULL CHECK (product_kind ~ '^[a-z][a-z0-9_]{1,39}$'),
  product_id uuid NOT NULL,
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{8,24}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked','expired')),
  policy_version text NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 80),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(partner_id,campaign_id,product_kind,product_id,policy_version),
  CHECK (expires_at > created_at)
);

CREATE TABLE streamer_attributions (
  id uuid PRIMARY KEY,
  buyer_user_id uuid NOT NULL REFERENCES users(id),
  buyer_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  partner_id uuid NOT NULL REFERENCES streamer_partners(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  owner_beneficial_owner_digest text NOT NULL CHECK (char_length(owner_beneficial_owner_digest) BETWEEN 16 AND 160),
  buyer_beneficial_owner_digest text NOT NULL CHECK (char_length(buyer_beneficial_owner_digest) BETWEEN 16 AND 160),
  promotion_code_id uuid NOT NULL REFERENCES streamer_promotion_codes(id),
  product_kind text NOT NULL CHECK (product_kind ~ '^[a-z][a-z0-9_]{1,39}$'),
  product_id uuid NOT NULL,
  policy_version text NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 80),
  policy_snapshot jsonb NOT NULL,
  payload_digest text NOT NULL CHECK (char_length(payload_digest) BETWEEN 16 AND 160),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','replaced','expired','revoked')),
  attributed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (buyer_user_id <> owner_user_id),
  CHECK (buyer_beneficial_owner_digest <> owner_beneficial_owner_digest),
  CHECK (expires_at > attributed_at)
);
CREATE UNIQUE INDEX streamer_attributions_active_product
  ON streamer_attributions(buyer_subject_id,product_kind,product_id) WHERE status='active';

CREATE TABLE invite_codes (
  id uuid PRIMARY KEY,
  inviter_user_id uuid NOT NULL REFERENCES users(id),
  owner_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  beneficial_owner_digest text NOT NULL CHECK (char_length(beneficial_owner_digest) BETWEEN 16 AND 160),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{8,24}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked','expired')),
  policy_version text NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 80),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(inviter_user_id,policy_version),
  CHECK (expires_at > created_at)
);

CREATE TABLE invite_attributions (
  id uuid PRIMARY KEY,
  invitee_user_id uuid NOT NULL UNIQUE REFERENCES users(id),
  invitee_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  inviter_user_id uuid NOT NULL REFERENCES users(id),
  inviter_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  invite_code_id uuid NOT NULL REFERENCES invite_codes(id),
  inviter_beneficial_owner_digest text NOT NULL CHECK (char_length(inviter_beneficial_owner_digest) BETWEEN 16 AND 160),
  invitee_beneficial_owner_digest text NOT NULL CHECK (char_length(invitee_beneficial_owner_digest) BETWEEN 16 AND 160),
  policy_version text NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 80),
  policy_snapshot jsonb NOT NULL,
  payload_digest text NOT NULL CHECK (char_length(payload_digest) BETWEEN 16 AND 160),
  attributed_at timestamptz NOT NULL,
  registered_at timestamptz NOT NULL,
  first_order_deadline timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (invitee_user_id <> inviter_user_id),
  CHECK (invitee_subject_id <> inviter_subject_id),
  CHECK (invitee_beneficial_owner_digest <> inviter_beneficial_owner_digest),
  CHECK (attributed_at <= registered_at),
  CHECK (first_order_deadline > registered_at)
);

CREATE TABLE streamer_commission_orders (
  id uuid PRIMARY KEY,
  order_kind text NOT NULL CHECK (order_kind IN ('credit_order','device_order','vast_order')),
  order_id uuid NOT NULL,
  attribution_id uuid NOT NULL REFERENCES streamer_attributions(id),
  promotion_code_id uuid NOT NULL REFERENCES streamer_promotion_codes(id),
  partner_id uuid NOT NULL REFERENCES streamer_partners(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  buyer_user_id uuid NOT NULL REFERENCES users(id),
  buyer_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  product_kind text NOT NULL CHECK (product_kind ~ '^[a-z][a-z0-9_]{1,39}$'),
  product_id uuid NOT NULL,
  policy_version text NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 80),
  policy_snapshot jsonb NOT NULL,
  basis_points integer NOT NULL CHECK (basis_points BETWEEN 1 AND 300),
  observation_days integer NOT NULL CHECK (observation_days BETWEEN 1 AND 30),
  final_net_consumed_micros bigint CHECK (final_net_consumed_micros >= 0 AND final_net_consumed_micros % 10000 = 0),
  reward_micros bigint CHECK (reward_micros >= 0 AND reward_micros % 10000 = 0),
  source_version bigint CHECK (source_version > 0),
  source_event_id text,
  status text NOT NULL DEFAULT 'attributed' CHECK (status IN (
    'attributed','observation','available','transferred','reversed','recovery_required'
  )),
  settled_at timestamptz,
  observation_ends_at timestamptz,
  available_at timestamptz,
  transferred_at timestamptz,
  reversed_at timestamptz,
  recovery_required_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(order_kind,order_id),
  CHECK (status<>'attributed' OR settled_at IS NULL),
  CHECK (settled_at IS NOT NULL OR status IN ('attributed','reversed')),
  CHECK ((settled_at IS NULL)=(final_net_consumed_micros IS NULL)),
  CHECK ((final_net_consumed_micros IS NULL)=(reward_micros IS NULL)),
  CHECK ((final_net_consumed_micros IS NULL)=(source_version IS NULL)),
  CHECK ((source_version IS NULL)=(source_event_id IS NULL)),
  CHECK (status<>'observation' OR observation_ends_at IS NOT NULL),
  CHECK (status NOT IN ('available','transferred','recovery_required') OR available_at IS NOT NULL),
  CHECK (status NOT IN ('transferred','recovery_required') OR transferred_at IS NOT NULL),
  CHECK ((status='reversed')=(reversed_at IS NOT NULL)),
  CHECK ((status='recovery_required')=(recovery_required_at IS NOT NULL))
);

CREATE TABLE invite_reward_orders (
  id uuid PRIMARY KEY,
  order_kind text NOT NULL CHECK (order_kind IN ('credit_order','device_order','vast_order')),
  order_id uuid NOT NULL,
  attribution_id uuid NOT NULL REFERENCES invite_attributions(id),
  invite_code_id uuid NOT NULL REFERENCES invite_codes(id),
  inviter_user_id uuid NOT NULL REFERENCES users(id),
  invitee_user_id uuid NOT NULL UNIQUE REFERENCES users(id),
  buyer_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  product_kind text NOT NULL CHECK (product_kind ~ '^[a-z][a-z0-9_]{1,39}$'),
  product_id uuid NOT NULL,
  policy_version text NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 80),
  policy_snapshot jsonb NOT NULL,
  basis_points integer NOT NULL CHECK (basis_points BETWEEN 1 AND 300),
  observation_days integer NOT NULL CHECK (observation_days BETWEEN 1 AND 30),
  final_net_consumed_micros bigint CHECK (final_net_consumed_micros >= 0 AND final_net_consumed_micros % 10000 = 0),
  reward_micros bigint CHECK (reward_micros >= 0 AND reward_micros % 10000 = 0),
  source_version bigint CHECK (source_version > 0),
  source_event_id text,
  status text NOT NULL DEFAULT 'attributed' CHECK (status IN (
    'attributed','observation','available','transferred','reversed','recovery_required'
  )),
  settled_at timestamptz,
  observation_ends_at timestamptz,
  available_at timestamptz,
  transferred_at timestamptz,
  reversed_at timestamptz,
  recovery_required_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(order_kind,order_id),
  CHECK (status<>'attributed' OR settled_at IS NULL),
  CHECK (settled_at IS NOT NULL OR status IN ('attributed','reversed')),
  CHECK ((settled_at IS NULL)=(final_net_consumed_micros IS NULL)),
  CHECK ((final_net_consumed_micros IS NULL)=(reward_micros IS NULL)),
  CHECK ((final_net_consumed_micros IS NULL)=(source_version IS NULL)),
  CHECK ((source_version IS NULL)=(source_event_id IS NULL)),
  CHECK (status<>'observation' OR observation_ends_at IS NOT NULL),
  CHECK (status NOT IN ('available','transferred','recovery_required') OR available_at IS NOT NULL),
  CHECK (status NOT IN ('transferred','recovery_required') OR transferred_at IS NOT NULL),
  CHECK ((status='reversed')=(reversed_at IS NOT NULL)),
  CHECK ((status='recovery_required')=(recovery_required_at IS NOT NULL))
);

CREATE TABLE reward_order_claims (
  id uuid PRIMARY KEY,
  domain text NOT NULL CHECK (domain IN ('streamer','invite')),
  order_kind text NOT NULL CHECK (order_kind IN ('credit_order','device_order','vast_order')),
  order_id uuid NOT NULL,
  domain_order_id uuid NOT NULL,
  buyer_user_id uuid NOT NULL REFERENCES users(id),
  buyer_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  product_kind text NOT NULL CHECK (product_kind ~ '^[a-z][a-z0-9_]{1,39}$'),
  product_id uuid NOT NULL,
  policy_version text NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 80),
  policy_snapshot jsonb NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(order_kind,order_id),
  UNIQUE(domain,domain_order_id)
);

CREATE TABLE reward_event_receipts (
  id uuid PRIMARY KEY,
  domain text NOT NULL CHECK (domain IN ('streamer','invite')),
  source text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_.-]{2,79}$'),
  event_id text NOT NULL CHECK (char_length(event_id) BETWEEN 8 AND 160),
  order_kind text NOT NULL CHECK (order_kind IN ('credit_order','device_order','vast_order')),
  order_id uuid NOT NULL,
  payload_digest text NOT NULL CHECK (char_length(payload_digest) BETWEEN 16 AND 160),
  source_version bigint NOT NULL CHECK (source_version > 0),
  state text NOT NULL DEFAULT 'claimed' CHECK (state IN ('claimed','processed','ignored')),
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE(domain,source,event_id),
  CHECK ((state='claimed')=(processed_at IS NULL))
);

CREATE TABLE reward_accounts (
  id uuid PRIMARY KEY,
  domain text NOT NULL CHECK (domain IN ('streamer','invite')),
  owner_kind text NOT NULL CHECK (owner_kind IN ('user','platform')),
  owner_user_id uuid REFERENCES users(id),
  code text NOT NULL UNIQUE CHECK (char_length(code) BETWEEN 3 AND 180),
  account_kind text NOT NULL CHECK (account_kind IN ('pending','available','transferred','clearing')),
  allow_negative boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_kind='user')=(owner_user_id IS NOT NULL)),
  CHECK ((owner_kind='platform')=(account_kind='clearing')),
  CHECK ((owner_kind='platform')=allow_negative)
);
CREATE UNIQUE INDEX reward_accounts_user_kind
  ON reward_accounts(domain,owner_user_id,account_kind) WHERE owner_user_id IS NOT NULL;
CREATE UNIQUE INDEX reward_accounts_platform_clearing
  ON reward_accounts(domain,account_kind) WHERE owner_kind='platform';

INSERT INTO reward_accounts(id,domain,owner_kind,owner_user_id,code,account_kind,allow_negative)
VALUES
  ('00000000-0000-4000-8000-000000000301','streamer','platform',NULL,'reward:streamer:platform:clearing','clearing',true),
  ('00000000-0000-4000-8000-000000000302','invite','platform',NULL,'reward:invite:platform:clearing','clearing',true);

CREATE TABLE reward_transactions (
  id uuid PRIMARY KEY,
  domain text NOT NULL CHECK (domain IN ('streamer','invite')),
  idempotency_owner text NOT NULL CHECK (char_length(idempotency_owner) BETWEEN 3 AND 180),
  scope text NOT NULL CHECK (scope IN ('REWARD_EARN','REWARD_MATURE','REWARD_REVERSE','REWARD_TRANSFER')),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 180),
  payload_digest text NOT NULL CHECK (char_length(payload_digest) BETWEEN 16 AND 160),
  association_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','posted')),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz,
  UNIQUE(domain,idempotency_owner,scope,idempotency_key),
  CHECK ((status='posted')=(posted_at IS NOT NULL)),
  CHECK ((scope='REWARD_TRANSFER')=(association_id IS NULL))
);

CREATE TABLE reward_entries (
  id uuid PRIMARY KEY,
  domain text NOT NULL CHECK (domain IN ('streamer','invite')),
  transaction_id uuid NOT NULL REFERENCES reward_transactions(id),
  account_id uuid NOT NULL REFERENCES reward_accounts(id),
  amount_micros bigint NOT NULL CHECK (amount_micros <> 0 AND amount_micros % 10000 = 0),
  memo text NOT NULL CHECK (char_length(memo) BETWEEN 1 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(transaction_id,account_id)
);
CREATE INDEX reward_entries_account ON reward_entries(account_id,created_at DESC);

CREATE TABLE reward_transfers (
  id uuid PRIMARY KEY,
  domain text NOT NULL CHECK (domain IN ('streamer','invite')),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  target_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  client_request_id text NOT NULL CHECK (char_length(client_request_id) BETWEEN 16 AND 120),
  payload_digest text NOT NULL CHECK (char_length(payload_digest) BETWEEN 16 AND 160),
  reward_micros bigint NOT NULL CHECK (reward_micros > 0 AND reward_micros % 10000 = 0),
  reward_transaction_id uuid NOT NULL UNIQUE REFERENCES reward_transactions(id),
  kai_credit_transaction_id uuid NOT NULL UNIQUE REFERENCES kai_credit_transactions(id),
  status text NOT NULL CHECK (status='succeeded'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(domain,owner_user_id,client_request_id)
);

CREATE INDEX streamer_commission_orders_actionable
  ON streamer_commission_orders(status,observation_ends_at,updated_at)
  WHERE status IN ('observation','available');
CREATE INDEX invite_reward_orders_actionable
  ON invite_reward_orders(status,observation_ends_at,updated_at)
  WHERE status IN ('observation','available');
CREATE INDEX reward_event_receipts_claimed
  ON reward_event_receipts(created_at,id) WHERE state='claimed';

CREATE FUNCTION validate_streamer_promotion_code() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE partner_user uuid;
DECLARE partner_status text;
BEGIN
  SELECT user_id,status INTO partner_user,partner_status FROM streamer_partners WHERE id=NEW.partner_id FOR UPDATE;
  IF NEW.status='active' AND (partner_status IS DISTINCT FROM 'approved' OR partner_user IS DISTINCT FROM NEW.owner_user_id) THEN
    RAISE EXCEPTION 'active streamer promotion code requires approved matching partner';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_streamer_partner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE user_status text;
DECLARE subject_status text;
DECLARE subject_owner uuid;
BEGIN
  SELECT status INTO user_status FROM users WHERE id=NEW.user_id FOR UPDATE;
  SELECT status,owner_user_id INTO subject_status,subject_owner FROM trading_subjects WHERE id=NEW.subject_id FOR UPDATE;
  IF NEW.status IN ('applied','approved') AND (user_status IS DISTINCT FROM 'active'
    OR subject_status IS DISTINCT FROM 'active' OR subject_owner IS DISTINCT FROM NEW.user_id) THEN
    RAISE EXCEPTION 'streamer partner requires active user and owned subject';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION protect_streamer_partner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'streamer partners cannot be deleted'; END IF;
  IF NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id OR NEW.subject_id<>OLD.subject_id
    OR NEW.beneficial_owner_digest<>OLD.beneficial_owner_digest OR NEW.applied_at<>OLD.applied_at
    OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'streamer partner identity is immutable'; END IF;
  IF NOT ((OLD.status='applied' AND NEW.status IN ('applied','approved','rejected'))
    OR (OLD.status='approved' AND NEW.status IN ('approved','suspended'))
    OR (OLD.status='suspended' AND NEW.status IN ('suspended','approved'))
    OR (OLD.status='rejected' AND NEW.status='rejected')) THEN RAISE EXCEPTION 'invalid streamer partner transition'; END IF;
  IF OLD.reviewed_at IS NOT NULL AND (NEW.reviewed_at<>OLD.reviewed_at
    OR NEW.reviewed_by_user_id<>OLD.reviewed_by_user_id) THEN RAISE EXCEPTION 'streamer review is immutable'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION protect_reward_code() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'reward codes cannot be deleted'; END IF;
  IF NEW.id<>OLD.id OR NEW.code<>OLD.code OR NEW.policy_version<>OLD.policy_version
    OR NEW.expires_at<>OLD.expires_at OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'reward code identity is immutable'; END IF;
  IF TG_TABLE_NAME='streamer_promotion_codes' AND (
    to_jsonb(NEW)->'partner_id' IS DISTINCT FROM to_jsonb(OLD)->'partner_id'
    OR to_jsonb(NEW)->'owner_user_id' IS DISTINCT FROM to_jsonb(OLD)->'owner_user_id'
    OR to_jsonb(NEW)->'campaign_id' IS DISTINCT FROM to_jsonb(OLD)->'campaign_id'
    OR to_jsonb(NEW)->'product_kind' IS DISTINCT FROM to_jsonb(OLD)->'product_kind'
    OR to_jsonb(NEW)->'product_id' IS DISTINCT FROM to_jsonb(OLD)->'product_id'
  ) THEN RAISE EXCEPTION 'streamer code identity is immutable'; END IF;
  IF TG_TABLE_NAME='invite_codes' AND (
    to_jsonb(NEW)->'inviter_user_id' IS DISTINCT FROM to_jsonb(OLD)->'inviter_user_id'
    OR to_jsonb(NEW)->'owner_subject_id' IS DISTINCT FROM to_jsonb(OLD)->'owner_subject_id'
    OR to_jsonb(NEW)->'beneficial_owner_digest' IS DISTINCT FROM to_jsonb(OLD)->'beneficial_owner_digest'
  ) THEN RAISE EXCEPTION 'invite code identity is immutable'; END IF;
  IF NOT ((OLD.status='active' AND NEW.status IN ('active','suspended','revoked','expired'))
    OR (OLD.status='suspended' AND NEW.status IN ('suspended','active','revoked','expired'))
    OR (OLD.status IN ('revoked','expired') AND NEW.status=OLD.status)) THEN RAISE EXCEPTION 'invalid reward code transition'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION protect_streamer_attribution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'streamer attributions cannot be deleted'; END IF;
  IF NEW.id<>OLD.id OR NEW.buyer_user_id<>OLD.buyer_user_id OR NEW.buyer_subject_id<>OLD.buyer_subject_id
    OR NEW.partner_id<>OLD.partner_id OR NEW.owner_user_id<>OLD.owner_user_id
    OR NEW.owner_beneficial_owner_digest<>OLD.owner_beneficial_owner_digest
    OR NEW.buyer_beneficial_owner_digest<>OLD.buyer_beneficial_owner_digest
    OR NEW.promotion_code_id<>OLD.promotion_code_id OR NEW.product_kind<>OLD.product_kind OR NEW.product_id<>OLD.product_id
    OR NEW.policy_version<>OLD.policy_version OR NEW.policy_snapshot<>OLD.policy_snapshot
    OR NEW.payload_digest<>OLD.payload_digest OR NEW.attributed_at<>OLD.attributed_at OR NEW.expires_at<>OLD.expires_at
    OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'streamer attribution identity is immutable'; END IF;
  IF NOT ((OLD.status='active' AND NEW.status IN ('active','replaced','expired','revoked'))
    OR (OLD.status<>'active' AND NEW.status=OLD.status)) THEN RAISE EXCEPTION 'invalid streamer attribution transition'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_streamer_attribution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE code_row streamer_promotion_codes%ROWTYPE;
DECLARE partner_status text;
DECLARE partner_beneficial_owner_digest text;
DECLARE buyer_status text;
DECLARE buyer_subject_status text;
DECLARE buyer_subject_owner uuid;
BEGIN
  SELECT * INTO code_row FROM streamer_promotion_codes WHERE id=NEW.promotion_code_id FOR UPDATE;
  SELECT status,beneficial_owner_digest INTO partner_status,partner_beneficial_owner_digest
    FROM streamer_partners WHERE id=NEW.partner_id FOR UPDATE;
  SELECT status INTO buyer_status FROM users WHERE id=NEW.buyer_user_id FOR UPDATE;
  SELECT status,owner_user_id INTO buyer_subject_status,buyer_subject_owner
    FROM trading_subjects WHERE id=NEW.buyer_subject_id FOR UPDATE;
  IF code_row.id IS NULL OR code_row.partner_id<>NEW.partner_id OR code_row.owner_user_id<>NEW.owner_user_id
    OR code_row.product_kind<>NEW.product_kind OR code_row.product_id<>NEW.product_id
    OR code_row.policy_version<>NEW.policy_version OR code_row.status<>'active' OR code_row.expires_at<=NEW.attributed_at
    OR partner_status IS DISTINCT FROM 'approved'
    OR partner_beneficial_owner_digest IS DISTINCT FROM NEW.owner_beneficial_owner_digest
    OR buyer_status IS DISTINCT FROM 'active' OR buyer_subject_status IS DISTINCT FROM 'active'
    OR buyer_subject_owner IS DISTINCT FROM NEW.buyer_user_id THEN
    RAISE EXCEPTION 'streamer attribution does not match an active approved product code';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_invite_code() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE user_status text;
DECLARE subject_status text;
DECLARE subject_owner uuid;
BEGIN
  SELECT status INTO user_status FROM users WHERE id=NEW.inviter_user_id FOR UPDATE;
  SELECT status,owner_user_id INTO subject_status,subject_owner FROM trading_subjects WHERE id=NEW.owner_subject_id FOR UPDATE;
  IF NEW.status='active' AND (user_status IS DISTINCT FROM 'active' OR subject_status IS DISTINCT FROM 'active'
    OR subject_owner IS DISTINCT FROM NEW.inviter_user_id) THEN
    RAISE EXCEPTION 'active invite code requires active local user and owned subject';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_invite_attribution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE code_row invite_codes%ROWTYPE;
DECLARE invitee_status text;
DECLARE subject_status text;
DECLARE subject_owner uuid;
BEGIN
  SELECT * INTO code_row FROM invite_codes WHERE id=NEW.invite_code_id FOR UPDATE;
  SELECT status INTO invitee_status FROM users WHERE id=NEW.invitee_user_id FOR UPDATE;
  SELECT status,owner_user_id INTO subject_status,subject_owner FROM trading_subjects WHERE id=NEW.invitee_subject_id FOR UPDATE;
  IF code_row.id IS NULL OR code_row.inviter_user_id<>NEW.inviter_user_id
    OR code_row.owner_subject_id<>NEW.inviter_subject_id OR code_row.policy_version<>NEW.policy_version
    OR code_row.beneficial_owner_digest<>NEW.inviter_beneficial_owner_digest OR code_row.status<>'active'
    OR code_row.expires_at<=NEW.attributed_at OR invitee_status IS DISTINCT FROM 'active'
    OR subject_status IS DISTINCT FROM 'active' OR subject_owner IS DISTINCT FROM NEW.invitee_user_id THEN
    RAISE EXCEPTION 'invite attribution does not match active users, subject and code';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_reward_order_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE matches integer;
BEGIN
  IF TG_OP<>'INSERT' OR NEW.status<>'attributed' THEN RAISE EXCEPTION 'reward orders must be inserted attributed'; END IF;
  IF TG_TABLE_NAME='streamer_commission_orders' THEN
    SELECT count(*) INTO matches FROM streamer_attributions a JOIN streamer_promotion_codes c ON c.id=a.promotion_code_id
      JOIN streamer_partners p ON p.id=a.partner_id WHERE a.id=NEW.attribution_id AND a.promotion_code_id=NEW.promotion_code_id
      AND a.partner_id=NEW.partner_id AND a.owner_user_id=NEW.owner_user_id AND a.buyer_user_id=NEW.buyer_user_id
      AND a.buyer_subject_id=NEW.buyer_subject_id AND a.product_kind=NEW.product_kind AND a.product_id=NEW.product_id
      AND a.policy_version=NEW.policy_version AND a.policy_snapshot=NEW.policy_snapshot AND a.status='active'
      AND c.status='active' AND p.status='approved';
  ELSE
    SELECT count(*) INTO matches FROM invite_attributions a JOIN invite_codes c ON c.id=a.invite_code_id
      WHERE a.id=NEW.attribution_id AND a.invite_code_id=NEW.invite_code_id
      AND a.inviter_user_id=NEW.inviter_user_id AND a.invitee_user_id=NEW.invitee_user_id
      AND a.invitee_subject_id=NEW.buyer_subject_id AND a.policy_version=NEW.policy_version
      AND a.policy_snapshot=NEW.policy_snapshot AND c.status='active';
  END IF;
  IF matches<>1 THEN RAISE EXCEPTION 'reward order does not match immutable attribution snapshot'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION protect_reward_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'reward accounts cannot be deleted'; END IF;
  IF NEW.id<>OLD.id OR NEW.domain<>OLD.domain OR NEW.owner_kind<>OLD.owner_kind
    OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.code<>OLD.code
    OR NEW.account_kind<>OLD.account_kind OR NEW.allow_negative<>OLD.allow_negative OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'reward account identity is immutable';
  END IF;
  IF NOT ((OLD.status='active' AND NEW.status IN ('active','frozen','closed'))
    OR (OLD.status='frozen' AND NEW.status IN ('frozen','closed')) OR (OLD.status='closed' AND NEW.status='closed')) THEN
    RAISE EXCEPTION 'invalid reward account status transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION protect_reward_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE transaction_domain text;
DECLARE transaction_status text;
DECLARE transaction_scope text;
DECLARE account_domain text;
DECLARE account_status text;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'reward entries are immutable'; END IF;
  SELECT domain,status,scope INTO transaction_domain,transaction_status,transaction_scope
    FROM reward_transactions WHERE id=NEW.transaction_id FOR UPDATE;
  SELECT domain,status INTO account_domain,account_status FROM reward_accounts WHERE id=NEW.account_id FOR UPDATE;
  IF transaction_status IS DISTINCT FROM 'pending' OR account_status IS NULL OR account_status='closed'
    OR (account_status='frozen' AND transaction_scope='REWARD_TRANSFER')
    OR transaction_domain IS DISTINCT FROM NEW.domain OR account_domain IS DISTINCT FROM NEW.domain THEN
    RAISE EXCEPTION 'reward entry domain or state is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION post_reward_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry_count integer;
DECLARE entry_total numeric;
DECLARE invalid_domain uuid;
DECLARE negative_account uuid;
DECLARE association_matches integer;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'pending' OR NEW.posted_at IS NOT NULL THEN
      RAISE EXCEPTION 'reward transactions must be inserted pending';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='posted' THEN RAISE EXCEPTION 'posted reward transactions are immutable'; END IF;
  IF NEW.id<>OLD.id OR NEW.domain<>OLD.domain OR NEW.idempotency_owner<>OLD.idempotency_owner
    OR NEW.scope<>OLD.scope OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.payload_digest<>OLD.payload_digest
    OR NEW.association_id IS DISTINCT FROM OLD.association_id OR NEW.description<>OLD.description OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'reward transaction identity is immutable';
  END IF;
  IF NEW.status<>'posted' THEN RETURN NEW; END IF;
  IF NEW.association_id IS NOT NULL THEN
    IF NEW.domain='streamer' THEN SELECT count(*) INTO association_matches FROM streamer_commission_orders WHERE id=NEW.association_id;
    ELSE SELECT count(*) INTO association_matches FROM invite_reward_orders WHERE id=NEW.association_id; END IF;
    IF association_matches<>1 THEN RAISE EXCEPTION 'reward transaction association domain is invalid'; END IF;
  END IF;
  PERFORM a.id FROM reward_accounts a JOIN reward_entries e ON e.account_id=a.id
    WHERE e.transaction_id=NEW.id ORDER BY a.id FOR UPDATE OF a;
  SELECT count(*),COALESCE(sum(amount_micros),0) INTO entry_count,entry_total FROM reward_entries WHERE transaction_id=NEW.id;
  IF entry_count<2 OR entry_total<>0 THEN RAISE EXCEPTION 'reward transaction must contain balanced entries'; END IF;
  SELECT e.id INTO invalid_domain FROM reward_entries e JOIN reward_accounts a ON a.id=e.account_id
    WHERE e.transaction_id=NEW.id AND (e.domain<>NEW.domain OR a.domain<>NEW.domain) LIMIT 1;
  IF invalid_domain IS NOT NULL THEN RAISE EXCEPTION 'reward transaction cannot cross domains'; END IF;
  SELECT a.id INTO negative_account FROM reward_accounts a
    JOIN reward_entries current_entry ON current_entry.account_id=a.id AND current_entry.transaction_id=NEW.id
    WHERE a.allow_negative=false AND (COALESCE((SELECT sum(e.amount_micros) FROM reward_entries e
      JOIN reward_transactions t ON t.id=e.transaction_id
      WHERE e.account_id=a.id AND t.status='posted'),0)+current_entry.amount_micros)<0 LIMIT 1;
  IF negative_account IS NOT NULL THEN RAISE EXCEPTION 'reward account cannot become negative'; END IF;
  NEW.posted_at=COALESCE(NEW.posted_at,now());
  RETURN NEW;
END;
$$;

CREATE FUNCTION protect_reward_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'reward orders cannot be deleted'; END IF;
  IF NEW.id<>OLD.id OR NEW.order_kind<>OLD.order_kind OR NEW.order_id<>OLD.order_id
    OR NEW.attribution_id<>OLD.attribution_id OR NEW.buyer_subject_id<>OLD.buyer_subject_id
    OR NEW.product_kind<>OLD.product_kind OR NEW.product_id<>OLD.product_id
    OR NEW.policy_version<>OLD.policy_version OR NEW.policy_snapshot<>OLD.policy_snapshot
    OR NEW.basis_points<>OLD.basis_points OR NEW.observation_days<>OLD.observation_days OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'reward order attribution snapshot is immutable';
  END IF;
  IF TG_TABLE_NAME='streamer_commission_orders' AND (
    to_jsonb(NEW)->'promotion_code_id' IS DISTINCT FROM to_jsonb(OLD)->'promotion_code_id'
    OR to_jsonb(NEW)->'partner_id' IS DISTINCT FROM to_jsonb(OLD)->'partner_id'
    OR to_jsonb(NEW)->'owner_user_id' IS DISTINCT FROM to_jsonb(OLD)->'owner_user_id'
    OR to_jsonb(NEW)->'buyer_user_id' IS DISTINCT FROM to_jsonb(OLD)->'buyer_user_id'
  ) THEN RAISE EXCEPTION 'streamer reward order identity is immutable'; END IF;
  IF TG_TABLE_NAME='invite_reward_orders' AND (
    to_jsonb(NEW)->'invite_code_id' IS DISTINCT FROM to_jsonb(OLD)->'invite_code_id'
    OR to_jsonb(NEW)->'inviter_user_id' IS DISTINCT FROM to_jsonb(OLD)->'inviter_user_id'
    OR to_jsonb(NEW)->'invitee_user_id' IS DISTINCT FROM to_jsonb(OLD)->'invitee_user_id'
  ) THEN RAISE EXCEPTION 'invite reward order identity is immutable'; END IF;
  IF OLD.source_version IS NOT NULL AND NEW.source_version IS DISTINCT FROM OLD.source_version
    AND NEW.source_version<=OLD.source_version THEN RAISE EXCEPTION 'reward source version must increase'; END IF;
  IF OLD.reward_micros IS NOT NULL AND NEW.reward_micros IS NOT NULL AND NEW.reward_micros>OLD.reward_micros THEN
    RAISE EXCEPTION 'reward revision cannot increase reward';
  END IF;
  IF NOT (
    (OLD.status='attributed' AND NEW.status IN ('attributed','observation','reversed'))
    OR (OLD.status='observation' AND NEW.status IN ('observation','available','reversed'))
    OR (OLD.status='available' AND NEW.status IN ('available','transferred','reversed'))
    OR (OLD.status='transferred' AND NEW.status IN ('transferred','recovery_required'))
    OR (OLD.status IN ('reversed','recovery_required') AND NEW.status=OLD.status)
  ) THEN RAISE EXCEPTION 'invalid reward order transition'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_reward_order_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE matches integer;
BEGIN
  IF NEW.domain='streamer' THEN
    SELECT count(*) INTO matches FROM streamer_commission_orders o WHERE o.id=NEW.domain_order_id
      AND o.order_kind=NEW.order_kind AND o.order_id=NEW.order_id AND o.buyer_user_id=NEW.buyer_user_id
      AND o.buyer_subject_id=NEW.buyer_subject_id AND o.product_kind=NEW.product_kind AND o.product_id=NEW.product_id
      AND o.policy_version=NEW.policy_version AND o.policy_snapshot=NEW.policy_snapshot;
  ELSE
    SELECT count(*) INTO matches FROM invite_reward_orders o WHERE o.id=NEW.domain_order_id
      AND o.order_kind=NEW.order_kind AND o.order_id=NEW.order_id AND o.invitee_user_id=NEW.buyer_user_id
      AND o.buyer_subject_id=NEW.buyer_subject_id AND o.product_kind=NEW.product_kind AND o.product_id=NEW.product_id
      AND o.policy_version=NEW.policy_version AND o.policy_snapshot=NEW.policy_snapshot;
  END IF;
  IF matches<>1 THEN RAISE EXCEPTION 'reward order claim does not match domain snapshot'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION protect_reward_event_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'reward event receipts cannot be deleted'; END IF;
  IF NEW.id<>OLD.id OR NEW.domain<>OLD.domain OR NEW.source<>OLD.source OR NEW.event_id<>OLD.event_id
    OR NEW.order_kind<>OLD.order_kind OR NEW.order_id<>OLD.order_id OR NEW.payload_digest<>OLD.payload_digest
    OR NEW.source_version<>OLD.source_version OR NEW.created_at<>OLD.created_at
    OR OLD.state<>'claimed' OR NEW.state NOT IN ('processed','ignored') OR NEW.processed_at IS NULL THEN
    RAISE EXCEPTION 'invalid reward event receipt mutation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION validate_reward_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reward_domain text;
DECLARE reward_scope text;
DECLARE reward_status text;
DECLARE reward_owner_amount numeric;
DECLARE kai_scope text;
DECLARE kai_status text;
DECLARE kai_reference text;
DECLARE kai_owner_amount numeric;
DECLARE target_owner uuid;
DECLARE target_status text;
DECLARE expected_kai_scope text;
BEGIN
  SELECT domain,scope,status INTO reward_domain,reward_scope,reward_status FROM reward_transactions
    WHERE id=NEW.reward_transaction_id;
  SELECT COALESCE(sum(e.amount_micros),0) INTO reward_owner_amount FROM reward_entries e
    JOIN reward_accounts a ON a.id=e.account_id WHERE e.transaction_id=NEW.reward_transaction_id
    AND a.domain=NEW.domain AND a.owner_user_id=NEW.owner_user_id AND a.account_kind='transferred';
  SELECT scope,status,reference_id INTO kai_scope,kai_status,kai_reference FROM kai_credit_transactions
    WHERE id=NEW.kai_credit_transaction_id;
  SELECT COALESCE(sum(e.amount_micros),0) INTO kai_owner_amount FROM kai_credit_entries e
    JOIN kai_credit_accounts a ON a.id=e.account_id WHERE e.transaction_id=NEW.kai_credit_transaction_id
    AND a.subject_id=NEW.target_subject_id AND a.account_kind='available';
  SELECT owner_user_id,status INTO target_owner,target_status FROM trading_subjects WHERE id=NEW.target_subject_id;
  expected_kai_scope:=CASE WHEN NEW.domain='streamer' THEN 'STREAMER_REWARD_TRANSFER' ELSE 'INVITE_REWARD_TRANSFER' END;
  IF reward_domain IS DISTINCT FROM NEW.domain OR reward_scope IS DISTINCT FROM 'REWARD_TRANSFER'
    OR reward_status IS DISTINCT FROM 'posted' OR reward_owner_amount<>NEW.reward_micros
    OR kai_scope IS DISTINCT FROM expected_kai_scope
    OR kai_status IS DISTINCT FROM 'posted' OR kai_reference IS DISTINCT FROM NEW.id::text
    OR kai_owner_amount<>NEW.reward_micros OR target_owner IS DISTINCT FROM NEW.owner_user_id
    OR target_status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'reward transfer ledgers or owner do not match'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER streamer_partners_updated_at BEFORE UPDATE ON streamer_partners
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER streamer_partners_validate BEFORE INSERT OR UPDATE ON streamer_partners
  FOR EACH ROW EXECUTE FUNCTION validate_streamer_partner();
CREATE TRIGGER streamer_partners_guard BEFORE UPDATE OR DELETE ON streamer_partners
  FOR EACH ROW EXECUTE FUNCTION protect_streamer_partner();
CREATE TRIGGER streamer_promotion_codes_validate BEFORE INSERT OR UPDATE ON streamer_promotion_codes
  FOR EACH ROW EXECUTE FUNCTION validate_streamer_promotion_code();
CREATE TRIGGER streamer_promotion_codes_guard BEFORE UPDATE OR DELETE ON streamer_promotion_codes
  FOR EACH ROW EXECUTE FUNCTION protect_reward_code();
CREATE TRIGGER streamer_attributions_validate BEFORE INSERT ON streamer_attributions
  FOR EACH ROW EXECUTE FUNCTION validate_streamer_attribution();
CREATE TRIGGER streamer_attributions_guard BEFORE UPDATE OR DELETE ON streamer_attributions
  FOR EACH ROW EXECUTE FUNCTION protect_streamer_attribution();
CREATE TRIGGER invite_codes_validate BEFORE INSERT OR UPDATE ON invite_codes
  FOR EACH ROW EXECUTE FUNCTION validate_invite_code();
CREATE TRIGGER invite_codes_guard BEFORE UPDATE OR DELETE ON invite_codes
  FOR EACH ROW EXECUTE FUNCTION protect_reward_code();
CREATE TRIGGER invite_attributions_validate BEFORE INSERT ON invite_attributions
  FOR EACH ROW EXECUTE FUNCTION validate_invite_attribution();
CREATE TRIGGER invite_attributions_immutable BEFORE UPDATE OR DELETE ON invite_attributions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER streamer_commission_orders_insert BEFORE INSERT ON streamer_commission_orders
  FOR EACH ROW EXECUTE FUNCTION validate_reward_order_insert();
CREATE TRIGGER invite_reward_orders_insert BEFORE INSERT ON invite_reward_orders
  FOR EACH ROW EXECUTE FUNCTION validate_reward_order_insert();
CREATE TRIGGER streamer_commission_orders_updated_at BEFORE UPDATE ON streamer_commission_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER invite_reward_orders_updated_at BEFORE UPDATE ON invite_reward_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER streamer_commission_orders_guard BEFORE UPDATE OR DELETE ON streamer_commission_orders
  FOR EACH ROW EXECUTE FUNCTION protect_reward_order();
CREATE TRIGGER invite_reward_orders_guard BEFORE UPDATE OR DELETE ON invite_reward_orders
  FOR EACH ROW EXECUTE FUNCTION protect_reward_order();
CREATE TRIGGER reward_order_claims_validate BEFORE INSERT ON reward_order_claims
  FOR EACH ROW EXECUTE FUNCTION validate_reward_order_claim();
CREATE TRIGGER reward_order_claims_immutable BEFORE UPDATE OR DELETE ON reward_order_claims
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER reward_event_receipts_guard BEFORE UPDATE OR DELETE ON reward_event_receipts
  FOR EACH ROW EXECUTE FUNCTION protect_reward_event_receipt();
CREATE TRIGGER reward_accounts_guard BEFORE UPDATE OR DELETE ON reward_accounts
  FOR EACH ROW EXECUTE FUNCTION protect_reward_account();
CREATE TRIGGER reward_transactions_post BEFORE INSERT OR UPDATE ON reward_transactions
  FOR EACH ROW EXECUTE FUNCTION post_reward_transaction();
CREATE TRIGGER reward_transactions_no_delete BEFORE DELETE ON reward_transactions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER reward_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON reward_entries
  FOR EACH ROW EXECUTE FUNCTION protect_reward_entry();
CREATE TRIGGER reward_transfers_immutable BEFORE UPDATE OR DELETE ON reward_transfers
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER reward_transfers_validate BEFORE INSERT ON reward_transfers
  FOR EACH ROW EXECUTE FUNCTION validate_reward_transfer();
