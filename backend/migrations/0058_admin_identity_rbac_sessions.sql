CREATE TABLE admin_identities (
  id uuid PRIMARY KEY,
  issuer text NOT NULL CHECK (char_length(issuer) BETWEEN 1 AND 500),
  subject_hash text NOT NULL CHECK (char_length(subject_hash) = 128),
  linked_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  email_ciphertext text CHECK (email_ciphertext IS NULL OR char_length(email_ciphertext) BETWEEN 1 AND 4096),
  email_lookup_hash text CHECK (email_lookup_hash IS NULL OR char_length(email_lookup_hash) = 64),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended','offboarded')),
  authz_version bigint NOT NULL DEFAULT 1 CHECK (authz_version >= 1),
  group_snapshot_digest text CHECK (group_snapshot_digest IS NULL OR char_length(group_snapshot_digest) = 128),
  last_authenticated_at timestamptz,
  last_group_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  disabled_reason_code text CHECK (disabled_reason_code IS NULL OR char_length(disabled_reason_code) BETWEEN 1 AND 80),
  UNIQUE (issuer, subject_hash),
  CHECK ((status IN ('suspended','offboarded')) = (disabled_at IS NOT NULL))
);
CREATE INDEX admin_identities_status ON admin_identities(status, updated_at DESC);
CREATE INDEX admin_identities_linked_user ON admin_identities(linked_user_id) WHERE linked_user_id IS NOT NULL;
CREATE INDEX admin_identities_group_sync ON admin_identities(last_group_synced_at);
CREATE TRIGGER admin_identities_updated_at
  BEFORE UPDATE ON admin_identities FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE admin_role_assignments (
  id uuid PRIMARY KEY,
  admin_identity_id uuid NOT NULL REFERENCES admin_identities(id),
  role_code text NOT NULL CHECK (role_code IN (
    'support_viewer','supplier_reviewer','resource_reviewer','price_reviewer',
    'finance_viewer','audit_viewer','super_admin'
  )),
  source text NOT NULL CHECK (source IN ('oidc','manual')),
  source_reference_digest text CHECK (source_reference_digest IS NULL OR char_length(source_reference_digest) = 128),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
  valid_from timestamptz NOT NULL,
  expires_at timestamptz,
  granted_by_admin_id uuid REFERENCES admin_identities(id),
  grant_reason_code text CHECK (grant_reason_code IS NULL OR char_length(grant_reason_code) BETWEEN 1 AND 80),
  ticket_reference text CHECK (ticket_reference IS NULL OR char_length(ticket_reference) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by_admin_id uuid REFERENCES admin_identities(id),
  revocation_reason_code text CHECK (revocation_reason_code IS NULL OR char_length(revocation_reason_code) BETWEEN 1 AND 80),
  CHECK (source <> 'manual' OR granted_by_admin_id IS NOT NULL),
  CHECK (granted_by_admin_id IS NULL OR granted_by_admin_id <> admin_identity_id),
  CHECK (revoked_by_admin_id IS NULL OR revoked_by_admin_id <> admin_identity_id),
  CHECK (expires_at IS NULL OR expires_at > valid_from),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (status <> 'expired' OR expires_at IS NOT NULL)
);
CREATE UNIQUE INDEX admin_role_assignments_active_source
  ON admin_role_assignments(admin_identity_id, role_code, source, COALESCE(source_reference_digest,''))
  WHERE status = 'active';
CREATE INDEX admin_role_assignments_identity_active
  ON admin_role_assignments(admin_identity_id, valid_from, expires_at) WHERE status = 'active';
CREATE INDEX admin_role_assignments_role_active
  ON admin_role_assignments(role_code, admin_identity_id) WHERE status = 'active';

CREATE TABLE admin_sessions (
  id uuid PRIMARY KEY,
  admin_identity_id uuid NOT NULL REFERENCES admin_identities(id),
  token_hash text NOT NULL UNIQUE CHECK (char_length(token_hash) = 128),
  previous_token_hash text UNIQUE CHECK (previous_token_hash IS NULL OR char_length(previous_token_hash) = 128),
  previous_token_valid_until timestamptz,
  csrf_token_hash text NOT NULL CHECK (char_length(csrf_token_hash) = 128),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
  authz_version_at_issue bigint NOT NULL CHECK (authz_version_at_issue >= 1),
  permission_definition_version text NOT NULL CHECK (char_length(permission_definition_version) BETWEEN 1 AND 80),
  permission_snapshot_digest text NOT NULL CHECK (char_length(permission_snapshot_digest) = 128),
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  rotated_at timestamptz,
  reauthenticated_at timestamptz,
  revoked_at timestamptz,
  revocation_reason_code text CHECK (revocation_reason_code IS NULL OR char_length(revocation_reason_code) BETWEEN 1 AND 80),
  created_ip_hash text NOT NULL CHECK (char_length(created_ip_hash) = 64),
  last_ip_hash text NOT NULL CHECK (char_length(last_ip_hash) = 64),
  user_agent_hash text NOT NULL CHECK (char_length(user_agent_hash) = 64),
  CHECK ((previous_token_hash IS NULL) = (previous_token_valid_until IS NULL)),
  CHECK (previous_token_hash IS NULL OR previous_token_hash <> token_hash),
  CHECK (previous_token_hash IS NULL OR rotated_at IS NOT NULL),
  CHECK (previous_token_valid_until IS NULL OR previous_token_valid_until > rotated_at),
  CHECK (previous_token_valid_until IS NULL OR previous_token_valid_until <= absolute_expires_at),
  CHECK (last_seen_at >= created_at),
  CHECK (idle_expires_at > last_seen_at),
  CHECK (idle_expires_at <= absolute_expires_at),
  CHECK (absolute_expires_at > created_at),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX admin_sessions_active_expiry
  ON admin_sessions(idle_expires_at, absolute_expires_at) WHERE status = 'active';
CREATE INDEX admin_sessions_identity
  ON admin_sessions(admin_identity_id, created_at DESC);
CREATE INDEX admin_sessions_identity_active
  ON admin_sessions(admin_identity_id, absolute_expires_at) WHERE status = 'active';

CREATE TABLE admin_session_token_hashes (
  token_hash text PRIMARY KEY CHECK (char_length(token_hash) = 128),
  admin_session_id uuid NOT NULL REFERENCES admin_sessions(id),
  token_kind text NOT NULL CHECK (token_kind IN ('current','previous')),
  valid_until timestamptz NOT NULL,
  claimed_at timestamptz NOT NULL,
  CHECK (valid_until > claimed_at)
);
CREATE UNIQUE INDEX admin_session_token_hashes_one_current
  ON admin_session_token_hashes(admin_session_id) WHERE token_kind = 'current';
CREATE INDEX admin_session_token_hashes_expiry ON admin_session_token_hashes(valid_until);

CREATE FUNCTION sync_admin_session_token_registry()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO admin_session_token_hashes(
      token_hash, admin_session_id, token_kind, valid_until, claimed_at
    ) VALUES (
      NEW.token_hash, NEW.id, 'current', NEW.absolute_expires_at, NEW.created_at
    );
    RETURN NEW;
  END IF;

  IF NEW.absolute_expires_at IS DISTINCT FROM OLD.absolute_expires_at THEN
    RAISE EXCEPTION 'ADMIN_SESSION_ABSOLUTE_EXPIRY_IMMUTABLE';
  END IF;
  IF NEW.token_hash IS NOT DISTINCT FROM OLD.token_hash THEN
    IF NEW.previous_token_hash IS DISTINCT FROM OLD.previous_token_hash
       OR NEW.previous_token_valid_until IS DISTINCT FROM OLD.previous_token_valid_until THEN
      RAISE EXCEPTION 'ADMIN_SESSION_TOKEN_TRANSITION_INVALID';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> 'active'
     OR NEW.previous_token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.previous_token_valid_until IS NULL
     OR NEW.rotated_at IS NULL THEN
    RAISE EXCEPTION 'ADMIN_SESSION_TOKEN_TRANSITION_INVALID';
  END IF;
  IF OLD.previous_token_valid_until IS NOT NULL
     AND OLD.previous_token_valid_until > NEW.rotated_at THEN
    RAISE EXCEPTION 'ADMIN_SESSION_ROTATION_GRACE_ACTIVE';
  END IF;

  UPDATE admin_session_token_hashes
     SET token_kind = 'previous', valid_until = NEW.previous_token_valid_until,
         claimed_at = NEW.rotated_at
   WHERE token_hash = OLD.token_hash AND admin_session_id = NEW.id AND token_kind = 'current';
  IF NOT FOUND THEN RAISE EXCEPTION 'ADMIN_SESSION_TOKEN_REGISTRY_MISSING'; END IF;

  INSERT INTO admin_session_token_hashes(
    token_hash, admin_session_id, token_kind, valid_until, claimed_at
  ) VALUES (
    NEW.token_hash, NEW.id, 'current', NEW.absolute_expires_at, NEW.rotated_at
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER admin_sessions_token_registry
  AFTER INSERT OR UPDATE OF token_hash, previous_token_hash,
    previous_token_valid_until, absolute_expires_at
  ON admin_sessions FOR EACH ROW EXECUTE FUNCTION sync_admin_session_token_registry();

CREATE TABLE admin_login_transactions (
  id uuid PRIMARY KEY,
  state_hash text NOT NULL UNIQUE CHECK (char_length(state_hash) = 128),
  browser_binding_hash text NOT NULL CHECK (char_length(browser_binding_hash) = 128),
  nonce_hash text NOT NULL CHECK (char_length(nonce_hash) = 128),
  pkce_verifier_ciphertext text NOT NULL CHECK (char_length(pkce_verifier_ciphertext) BETWEEN 1 AND 4096),
  return_path text NOT NULL CHECK (char_length(return_path) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'started' CHECK (status IN ('started','consumed','failed','expired')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_ip_hash text NOT NULL CHECK (char_length(created_ip_hash) = 64),
  user_agent_hash text NOT NULL CHECK (char_length(user_agent_hash) = 64),
  failure_code text CHECK (failure_code IS NULL OR char_length(failure_code) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL,
  CHECK (expires_at > created_at),
  CHECK (status <> 'consumed' OR consumed_at IS NOT NULL),
  CHECK (status <> 'started' OR consumed_at IS NULL)
);
CREATE INDEX admin_login_transactions_unfinished_expiry
  ON admin_login_transactions(expires_at) WHERE status = 'started';

CREATE TABLE admin_audit_events (
  id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  admin_identity_id uuid REFERENCES admin_identities(id),
  admin_session_id uuid REFERENCES admin_sessions(id),
  effective_permissions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(effective_permissions) = 'array'),
  permission_snapshot_digest text NOT NULL CHECK (char_length(permission_snapshot_digest) = 128),
  action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 120),
  target_type text CHECK (target_type IS NULL OR char_length(target_type) BETWEEN 1 AND 80),
  target_id text CHECK (target_id IS NULL OR char_length(target_id) BETWEEN 1 AND 200),
  request_id text NOT NULL CHECK (char_length(request_id) BETWEEN 1 AND 200),
  ticket_reference text CHECK (ticket_reference IS NULL OR char_length(ticket_reference) BETWEEN 1 AND 160),
  reason_code text CHECK (reason_code IS NULL OR char_length(reason_code) BETWEEN 1 AND 80),
  reason_digest text CHECK (reason_digest IS NULL OR char_length(reason_digest) = 128),
  idempotency_key_hash text CHECK (idempotency_key_hash IS NULL OR char_length(idempotency_key_hash) = 128),
  before_state_digest text CHECK (before_state_digest IS NULL OR char_length(before_state_digest) = 128),
  after_state_digest text CHECK (after_state_digest IS NULL OR char_length(after_state_digest) = 128),
  ip_hash text CHECK (ip_hash IS NULL OR char_length(ip_hash) = 64),
  user_agent_hash text CHECK (user_agent_hash IS NULL OR char_length(user_agent_hash) = 64),
  outcome text NOT NULL CHECK (outcome IN ('succeeded','denied','failed')),
  error_code text CHECK (error_code IS NULL OR char_length(error_code) BETWEEN 1 AND 120),
  sensitive_access boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX admin_audit_events_identity_time
  ON admin_audit_events(admin_identity_id, occurred_at DESC);
CREATE INDEX admin_audit_events_action_time ON admin_audit_events(action, occurred_at DESC);
CREATE INDEX admin_audit_events_target_time ON admin_audit_events(target_type, target_id, occurred_at DESC);
CREATE INDEX admin_audit_events_request ON admin_audit_events(request_id);
CREATE INDEX admin_audit_events_outcome_time ON admin_audit_events(outcome, occurred_at DESC);
CREATE INDEX admin_audit_events_sensitive_time
  ON admin_audit_events(occurred_at DESC) WHERE sensitive_access = true;
CREATE INDEX admin_audit_events_time ON admin_audit_events(occurred_at DESC);
CREATE TRIGGER admin_audit_events_immutable
  BEFORE UPDATE OR DELETE ON admin_audit_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

-- Compliance enhancement deferred: append-only protection is enforced now;
-- previous_event_hash/event_hash chaining can be added after retention and WORM requirements are approved.
