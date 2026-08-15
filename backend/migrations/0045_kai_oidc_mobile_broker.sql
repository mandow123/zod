ALTER TABLE users ADD COLUMN federated_principal boolean NOT NULL DEFAULT false;
ALTER TABLE users DROP CONSTRAINT users_check;
ALTER TABLE users ADD CONSTRAINT users_auth_anchor_check CHECK (
  phone_ciphertext IS NOT NULL OR email_ciphertext IS NOT NULL OR federated_principal
);

CREATE TABLE kai_oidc_identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issuer text NOT NULL,
  subject_hash text NOT NULL,
  last_authenticated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject_hash)
);
CREATE INDEX kai_oidc_identities_user ON kai_oidc_identities(user_id);

CREATE TABLE kai_oidc_transactions (
  id uuid PRIMARY KEY,
  state_hash text NOT NULL UNIQUE,
  nonce_hash text NOT NULL,
  pkce_verifier_ciphertext text NOT NULL,
  app_redirect_uri text NOT NULL,
  app_code_challenge text NOT NULL,
  terms_version text NOT NULL,
  privacy_version text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE INDEX kai_oidc_transactions_expiry ON kai_oidc_transactions(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE kai_oidc_app_login_codes (
  id uuid PRIMARY KEY,
  transaction_id uuid NOT NULL UNIQUE REFERENCES kai_oidc_transactions(id),
  user_id uuid NOT NULL REFERENCES users(id),
  code_hash text NOT NULL UNIQUE,
  app_code_challenge text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE INDEX kai_oidc_app_login_codes_expiry ON kai_oidc_app_login_codes(expires_at) WHERE consumed_at IS NULL;
