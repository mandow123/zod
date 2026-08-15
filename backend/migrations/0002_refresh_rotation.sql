CREATE TABLE session_refresh_tokens (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES mobile_sessions(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'used', 'revoked')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  replaced_by_id uuid REFERENCES session_refresh_tokens(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX session_refresh_one_current ON session_refresh_tokens(session_id) WHERE status = 'current';
CREATE INDEX session_refresh_expiry ON session_refresh_tokens(expires_at);

ALTER TABLE mobile_sessions DROP COLUMN refresh_token_hash;
