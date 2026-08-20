CREATE TABLE IF NOT EXISTS sandbox_subjects (
  id uuid PRIMARY KEY,
  handle text UNIQUE NOT NULL,
  role text NOT NULL CHECK (role IN ('member','supplier','operator','admin')),
  token_hash text UNIQUE NOT NULL,
  version integer NOT NULL DEFAULT 1,
  simulation boolean NOT NULL CHECK (simulation),
  environment text NOT NULL CHECK (environment = 'staging')
);

CREATE TABLE IF NOT EXISTS sandbox_accounts (
  id uuid PRIMARY KEY,
  subject_id uuid REFERENCES sandbox_subjects(id),
  kind text NOT NULL CHECK (kind IN ('available','reserved','creator_available','creator_transferred','supplier_earned','demo_funding')),
  balance_micros bigint NOT NULL DEFAULT 0 CHECK (balance_micros >= 0),
  version integer NOT NULL DEFAULT 1,
  simulation boolean NOT NULL CHECK (simulation),
  environment text NOT NULL CHECK (environment = 'staging'),
  UNIQUE(subject_id, kind)
);

CREATE TABLE IF NOT EXISTS sandbox_ledger_entries (
  id uuid PRIMARY KEY,
  transaction_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES sandbox_accounts(id),
  delta_micros bigint NOT NULL CHECK (delta_micros % 10000 = 0),
  reason text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  simulation boolean NOT NULL CHECK (simulation),
  environment text NOT NULL CHECK (environment = 'staging'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sandbox_ledger_reason_once
  ON sandbox_ledger_entries(account_id, reason, entity_type, entity_id);

CREATE TABLE IF NOT EXISTS sandbox_listings (
  id uuid PRIMARY KEY,
  supplier_subject_id uuid NOT NULL REFERENCES sandbox_subjects(id),
  title text NOT NULL,
  product_code text UNIQUE NOT NULL,
  region text NOT NULL,
  specifications jsonb NOT NULL,
  capacity_unit text NOT NULL DEFAULT 'GPU时',
  unit_price_micros bigint NOT NULL CHECK (unit_price_micros > 0 AND unit_price_micros % 10000 = 0),
  capacity_total_minor bigint NOT NULL CHECK (capacity_total_minor >= 0),
  capacity_reserved_minor bigint NOT NULL DEFAULT 0 CHECK (capacity_reserved_minor >= 0),
  capacity_consumed_minor bigint NOT NULL DEFAULT 0 CHECK (capacity_consumed_minor >= 0),
  version integer NOT NULL DEFAULT 1,
  simulation boolean NOT NULL CHECK (simulation),
  environment text NOT NULL CHECK (environment = 'staging'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (capacity_reserved_minor + capacity_consumed_minor <= capacity_total_minor)
);

-- Supplier-owned staging drafts are deliberately isolated from listings. A
-- complete draft remains private and cannot be purchased or discovered.
CREATE TABLE IF NOT EXISTS sandbox_supplier_resource_drafts (
  id uuid PRIMARY KEY,
  supplier_subject_id uuid NOT NULL REFERENCES sandbox_subjects(id),
  client_draft_id uuid NOT NULL,
  create_payload_hash text NOT NULL,
  resource jsonb NOT NULL,
  delivery_plan jsonb,
  pricing jsonb NOT NULL,
  acknowledgements jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status = 'draft'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility = 'private'),
  purchasable boolean NOT NULL DEFAULT false CHECK (NOT purchasable),
  simulation boolean NOT NULL CHECK (simulation),
  environment text NOT NULL CHECK (environment = 'staging'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(supplier_subject_id, client_draft_id)
);
CREATE INDEX IF NOT EXISTS sandbox_supplier_resource_drafts_owner_updated
  ON sandbox_supplier_resource_drafts(supplier_subject_id, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS sandbox_ssh_public_keys (
  id uuid PRIMARY KEY,
  subject_id uuid NOT NULL REFERENCES sandbox_subjects(id),
  client_key_id uuid NOT NULL,
  label text NOT NULL,
  algorithm text NOT NULL CHECK (algorithm IN ('ssh-ed25519','sk-ssh-ed25519@openssh.com','ecdsa-sha2-nistp256','ssh-rsa')),
  fingerprint text NOT NULL,
  normalized_public_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','revoked')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_used_at timestamptz,
  simulation boolean NOT NULL CHECK (simulation),
  environment text NOT NULL CHECK (environment = 'staging'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(subject_id, client_key_id),
  UNIQUE(subject_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS sandbox_ssh_public_keys_owner_updated
  ON sandbox_ssh_public_keys(subject_id, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS sandbox_topups (
  id uuid PRIMARY KEY,
  subject_id uuid NOT NULL REFERENCES sandbox_subjects(id),
  payment_amount_cents bigint NOT NULL,
  credit_micros bigint NOT NULL CHECK (credit_micros % 10000 = 0),
  status text NOT NULL CHECK (status IN ('processing','succeeded','failed','canceled')),
  reason_code text,
  version integer NOT NULL DEFAULT 1,
  simulation boolean NOT NULL CHECK (simulation),
  environment text NOT NULL CHECK (environment = 'staging'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sandbox_orders (
  id uuid PRIMARY KEY,
  number text UNIQUE NOT NULL,
  buyer_subject_id uuid NOT NULL REFERENCES sandbox_subjects(id),
  listing_id uuid NOT NULL REFERENCES sandbox_listings(id),
  listing_snapshot jsonb NOT NULL,
  quantity_minor bigint NOT NULL CHECK (quantity_minor > 0),
  unit_price_micros bigint NOT NULL,
  total_micros bigint NOT NULL CHECK (total_micros % 10000 = 0),
  consumed_micros bigint,
  consumed_quantity_minor bigint,
  settled_micros bigint CHECK (settled_micros IS NULL OR settled_micros % 10000 = 0),
  status text NOT NULL CHECK (status IN ('reserved','canceled','acceptance_pending','accepted','refunded','disputed','failed')),
  fulfillment_status text NOT NULL CHECK (fulfillment_status IN ('queued','provisioning','ready','running','disconnected','stopping','stopped','failed')),
  connection_status text NOT NULL CHECK (connection_status IN ('not_available','ready','connected','disconnected','stopped')),
  evidence_ref text,
  version integer NOT NULL DEFAULT 1,
  simulation boolean NOT NULL CHECK (simulation),
  environment text NOT NULL CHECK (environment = 'staging'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sandbox_manual_delivery_requests (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES sandbox_orders(id),
  buyer_subject_id uuid NOT NULL REFERENCES sandbox_subjects(id),
  ssh_public_key_id uuid NOT NULL REFERENCES sandbox_ssh_public_keys(id),
  terms_version text NOT NULL CHECK (terms_version = 'staging-manual-delivery-v1'),
  status text NOT NULL CHECK (status IN ('submitted','key_verified','provisioning','ready','rejected','canceled')),
  evidence_ref text,
  reason_code text,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  simulation boolean NOT NULL CHECK (simulation),
  environment text NOT NULL CHECK (environment = 'staging'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sandbox_manual_delivery_one_active_order
  ON sandbox_manual_delivery_requests(order_id)
  WHERE status IN ('submitted','key_verified','provisioning','ready');
CREATE INDEX IF NOT EXISTS sandbox_manual_delivery_buyer_updated
  ON sandbox_manual_delivery_requests(buyer_subject_id, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS sandbox_disputes (
  id uuid PRIMARY KEY,
  order_id uuid UNIQUE NOT NULL REFERENCES sandbox_orders(id),
  subject_id uuid NOT NULL REFERENCES sandbox_subjects(id),
  category text NOT NULL,
  description text NOT NULL,
  status text NOT NULL CHECK (status IN ('open','resolved')),
  outcome text,
  refund_micros bigint,
  version integer NOT NULL DEFAULT 1,
  simulation boolean NOT NULL CHECK (simulation),
  environment text NOT NULL CHECK (environment = 'staging'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sandbox_referral_links (
  id uuid PRIMARY KEY, creator_subject_id uuid NOT NULL REFERENCES sandbox_subjects(id), token text UNIQUE NOT NULL,
  simulation boolean NOT NULL CHECK (simulation), environment text NOT NULL CHECK (environment='staging'), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sandbox_attributions (
  id uuid PRIMARY KEY, buyer_subject_id uuid UNIQUE NOT NULL REFERENCES sandbox_subjects(id), creator_subject_id uuid NOT NULL REFERENCES sandbox_subjects(id),
  simulation boolean NOT NULL CHECK (simulation), environment text NOT NULL CHECK (environment='staging'), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sandbox_commissions (
  id uuid PRIMARY KEY, order_id uuid UNIQUE NOT NULL REFERENCES sandbox_orders(id), creator_subject_id uuid NOT NULL REFERENCES sandbox_subjects(id),
  amount_micros bigint NOT NULL CHECK (amount_micros % 10000 = 0), status text NOT NULL CHECK(status IN ('attributed','refund_observation','available','reversed','transferred')),
  observation_started_at timestamptz, available_at timestamptz, version integer NOT NULL DEFAULT 1,
  simulation boolean NOT NULL CHECK (simulation), environment text NOT NULL CHECK(environment='staging'), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sandbox_reward_events (
  id uuid PRIMARY KEY, creator_subject_id uuid NOT NULL REFERENCES sandbox_subjects(id), transfer_id uuid UNIQUE NOT NULL, amount_micros bigint NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','consumed')), consumed_at timestamptz,
  simulation boolean NOT NULL CHECK(simulation), environment text NOT NULL CHECK(environment='staging'), created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sandbox_idempotency (
  actor_subject_id uuid NOT NULL REFERENCES sandbox_subjects(id), operation text NOT NULL, idempotency_key text NOT NULL,
  payload_hash text NOT NULL, response_status integer, response_body jsonb,
  simulation boolean NOT NULL CHECK(simulation), environment text NOT NULL CHECK(environment='staging'), created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((response_status IS NULL) = (response_body IS NULL)),
  PRIMARY KEY(actor_subject_id, operation, idempotency_key)
);
CREATE TABLE IF NOT EXISTS sandbox_audit (
  id uuid PRIMARY KEY, actor_subject_id uuid, action text NOT NULL, entity_type text NOT NULL, entity_id uuid NOT NULL, payload jsonb NOT NULL,
  priority text NOT NULL DEFAULT 'normal', simulation boolean NOT NULL CHECK(simulation), environment text NOT NULL CHECK(environment='staging'), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sandbox_outbox (
  id uuid PRIMARY KEY, topic text NOT NULL, entity_id uuid NOT NULL, payload jsonb NOT NULL, delivered_at timestamptz,
  simulation boolean NOT NULL CHECK(simulation), environment text NOT NULL CHECK(environment='staging'), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sandbox_resets (
  id uuid PRIMARY KEY, subject_id uuid NOT NULL REFERENCES sandbox_subjects(id), counts jsonb NOT NULL, completed_at timestamptz NOT NULL,
  simulation boolean NOT NULL CHECK(simulation), environment text NOT NULL CHECK(environment='staging')
);
CREATE TABLE IF NOT EXISTS sandbox_clock (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), current_at timestamptz NOT NULL,
  simulation boolean NOT NULL CHECK(simulation), environment text NOT NULL CHECK(environment='staging')
);
