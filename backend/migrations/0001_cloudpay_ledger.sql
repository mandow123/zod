CREATE TABLE users (
  id uuid PRIMARY KEY,
  phone_ciphertext text,
  phone_lookup_hash text,
  email_ciphertext text,
  email_lookup_hash text,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'supplier', 'operator', 'admin')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'suspended', 'deletion_pending', 'anonymized')),
  phone_verified_at timestamptz,
  email_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (phone_ciphertext IS NOT NULL OR email_ciphertext IS NOT NULL)
);
CREATE UNIQUE INDEX users_phone_unique ON users(phone_lookup_hash) WHERE phone_lookup_hash IS NOT NULL AND status <> 'anonymized';
CREATE UNIQUE INDEX users_email_unique ON users(email_lookup_hash) WHERE email_lookup_hash IS NOT NULL AND status <> 'anonymized';

CREATE TABLE legal_consents (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  document_kind text NOT NULL CHECK (document_kind IN ('terms', 'privacy', 'payment', 'supplier')),
  document_version text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip_hash text NOT NULL,
  user_agent_hash text NOT NULL,
  UNIQUE (user_id, document_kind, document_version)
);

CREATE TABLE otp_challenges (
  id uuid PRIMARY KEY,
  destination_hash text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('register', 'login', 'change_phone', 'delete_account')),
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_challenges_lookup ON otp_challenges(destination_hash, purpose, created_at DESC);

CREATE TABLE mobile_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  token_family uuid NOT NULL,
  refresh_token_hash text NOT NULL UNIQUE,
  device_id text NOT NULL,
  app_version text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('android', 'ios')),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revocation_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mobile_sessions_active_user ON mobile_sessions(user_id, expires_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX mobile_sessions_family ON mobile_sessions(token_family);

CREATE TABLE device_installations (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES users(id),
  device_id text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('android', 'ios')),
  push_token_ciphertext text,
  push_enabled boolean NOT NULL DEFAULT false,
  locale text NOT NULL DEFAULT 'zh-CN',
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  app_version text NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, platform)
);

CREATE TABLE supplier_profiles (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES users(id),
  legal_name text NOT NULL,
  credit_code text NOT NULL,
  contact_name text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'suspended')),
  rejection_reason text,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX supplier_profiles_credit_code_unique ON supplier_profiles(credit_code);

CREATE TABLE compute_resources (
  id uuid PRIMARY KEY,
  supplier_id uuid NOT NULL REFERENCES supplier_profiles(id),
  kind text NOT NULL CHECK (kind IN ('gpu', 'token_capacity', 'token_usage', 'rack', 'storage', 'apple_silicon')),
  product_code text NOT NULL,
  region text NOT NULL,
  specifications jsonb NOT NULL,
  capacity_total numeric(24,6) NOT NULL CHECK (capacity_total > 0),
  capacity_unit text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_verification', 'verified', 'rejected', 'suspended', 'retired')),
  verification_digest text,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE INDEX compute_resources_supplier_status ON compute_resources(supplier_id, status);

CREATE TABLE market_listings (
  id uuid PRIMARY KEY,
  resource_id uuid NOT NULL REFERENCES compute_resources(id),
  supplier_id uuid NOT NULL REFERENCES supplier_profiles(id),
  product_code text NOT NULL,
  region text NOT NULL,
  capacity_total numeric(24,6) NOT NULL CHECK (capacity_total > 0),
  capacity_reserved numeric(24,6) NOT NULL DEFAULT 0 CHECK (capacity_reserved >= 0),
  capacity_sold numeric(24,6) NOT NULL DEFAULT 0 CHECK (capacity_sold >= 0),
  capacity_unit text NOT NULL,
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  currency text NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  minimum_quantity numeric(24,6) NOT NULL CHECK (minimum_quantity > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'sold_out', 'expired', 'withdrawn')),
  starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CHECK (expires_at > starts_at),
  CHECK (capacity_reserved + capacity_sold <= capacity_total)
);
CREATE INDEX market_listings_active_search ON market_listings(status, region, product_code, unit_price_cents) WHERE status = 'active';

CREATE TABLE orders (
  id uuid PRIMARY KEY,
  order_number text NOT NULL UNIQUE,
  buyer_id uuid NOT NULL REFERENCES users(id),
  supplier_id uuid NOT NULL REFERENCES supplier_profiles(id),
  listing_id uuid NOT NULL REFERENCES market_listings(id),
  status text NOT NULL CHECK (status IN ('reserved', 'payment_pending', 'paid', 'delivery_pending', 'delivering', 'acceptance_pending', 'accepted', 'cancelled', 'refund_pending', 'refunded', 'disputed', 'closed')),
  quantity numeric(24,6) NOT NULL CHECK (quantity > 0),
  capacity_unit text NOT NULL,
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  subtotal_cents bigint NOT NULL CHECK (subtotal_cents >= 0),
  fee_cents bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  total_cents bigint NOT NULL CHECK (total_cents >= 0),
  currency text NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  listing_snapshot jsonb NOT NULL,
  reservation_expires_at timestamptz NOT NULL,
  paid_at timestamptz,
  accepted_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE INDEX orders_buyer_created ON orders(buyer_id, created_at DESC);
CREATE INDEX orders_supplier_status ON orders(supplier_id, status, created_at DESC);
CREATE INDEX orders_reservation_expiry ON orders(reservation_expires_at) WHERE status IN ('reserved', 'payment_pending');

CREATE TABLE order_events (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  actor_id uuid REFERENCES users(id),
  event_type text NOT NULL,
  from_status text,
  to_status text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_events_timeline ON order_events(order_id, created_at, id);

CREATE TABLE payment_intents (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  provider text NOT NULL CHECK (provider IN ('alipay', 'wechat')),
  provider_payment_id text,
  channel text NOT NULL,
  status text NOT NULL CHECK (status IN ('created', 'pending', 'succeeded', 'failed', 'expired', 'cancelled', 'refunding', 'refunded')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  checkout_url text,
  expires_at timestamptz NOT NULL,
  succeeded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, provider)
);
CREATE UNIQUE INDEX payment_intents_provider_id ON payment_intents(provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;

CREATE TABLE payment_events (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  payment_intent_id uuid REFERENCES payment_intents(id),
  signature_valid boolean NOT NULL,
  payload_digest text NOT NULL,
  normalized_payload jsonb NOT NULL,
  processed_at timestamptz,
  processing_error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE delivery_tasks (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
  supplier_id uuid NOT NULL REFERENCES supplier_profiles(id),
  status text NOT NULL CHECK (status IN ('pending', 'provisioning', 'ready', 'in_service', 'completed', 'failed', 'cancelled')),
  delivery_metadata_ciphertext text,
  started_at timestamptz,
  ready_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE metering_samples (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  source text NOT NULL CHECK (source IN ('supplier_agent', 'platform_probe', 'provider')),
  observed_at timestamptz NOT NULL,
  quantity numeric(24,6) NOT NULL CHECK (quantity >= 0),
  unit text NOT NULL,
  evidence_digest text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, source, observed_at, evidence_digest)
);
CREATE INDEX metering_samples_order_time ON metering_samples(order_id, observed_at);

CREATE TABLE acceptance_records (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
  buyer_id uuid NOT NULL REFERENCES users(id),
  result text NOT NULL CHECK (result IN ('accepted', 'rejected')),
  reason text,
  evidence_digest text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refunds (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  requested_by uuid NOT NULL REFERENCES users(id),
  payment_intent_id uuid REFERENCES payment_intents(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 8 AND 1000),
  status text NOT NULL CHECK (status IN ('requested', 'reviewing', 'approved', 'provider_pending', 'succeeded', 'rejected', 'failed')),
  provider_refund_id text,
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refunds_order_status ON refunds(order_id, status);

CREATE TABLE disputes (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  opened_by uuid NOT NULL REFERENCES users(id),
  category text NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 8 AND 2000),
  status text NOT NULL CHECK (status IN ('open', 'evidence_pending', 'reviewing', 'resolved_buyer', 'resolved_supplier', 'closed')),
  resolution text,
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX disputes_order_status ON disputes(order_id, status);

CREATE TABLE invoices (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  user_id uuid NOT NULL REFERENCES users(id),
  invoice_title text NOT NULL,
  tax_id text NOT NULL,
  email text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  status text NOT NULL CHECK (status IN ('requested', 'processing', 'issued', 'failed', 'cancelled')),
  document_object_key text,
  issued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, user_id)
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  category text NOT NULL CHECK (category IN ('order', 'payment', 'delivery', 'market', 'account', 'system')),
  title text NOT NULL,
  body text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_unread ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;

CREATE TABLE account_deletion_requests (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('requested', 'cooling_off', 'blocked_by_legal_hold', 'processing', 'completed', 'cancelled')),
  reason text,
  cooling_off_until timestamptz NOT NULL,
  legal_hold_reason text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  cancelled_at timestamptz
);
CREATE UNIQUE INDEX account_deletion_active ON account_deletion_requests(user_id) WHERE status IN ('requested', 'cooling_off', 'blocked_by_legal_hold', 'processing');

CREATE TABLE idempotency_records (
  id uuid PRIMARY KEY,
  actor_id uuid REFERENCES users(id),
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  payload_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('processing', 'completed', 'failed')),
  response_status integer,
  response_body jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_id, scope, idempotency_key)
);
CREATE INDEX idempotency_expiry ON idempotency_records(expires_at);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  actor_id uuid REFERENCES users(id),
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'operator', 'system', 'provider')),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  request_id text,
  ip_hash text,
  payload_digest text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_entity ON audit_events(entity_type, entity_id, created_at DESC);
CREATE INDEX audit_events_actor ON audit_events(actor_id, created_at DESC);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  topic text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  processed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending ON outbox_events(available_at, created_at) WHERE processed_at IS NULL;

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  IF to_jsonb(NEW) ? 'version' THEN NEW.version = OLD.version + 1; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER device_installations_updated_at BEFORE UPDATE ON device_installations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER supplier_profiles_updated_at BEFORE UPDATE ON supplier_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER compute_resources_updated_at BEFORE UPDATE ON compute_resources FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER market_listings_updated_at BEFORE UPDATE ON market_listings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER orders_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER payment_intents_updated_at BEFORE UPDATE ON payment_intents FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER delivery_tasks_updated_at BEFORE UPDATE ON delivery_tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER refunds_updated_at BEFORE UPDATE ON refunds FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER disputes_updated_at BEFORE UPDATE ON disputes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER invoices_updated_at BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER idempotency_records_updated_at BEFORE UPDATE ON idempotency_records FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION reject_immutable_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable ledger table % cannot be modified', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER order_events_immutable BEFORE UPDATE OR DELETE ON order_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER payment_events_immutable BEFORE UPDATE OR DELETE ON payment_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
