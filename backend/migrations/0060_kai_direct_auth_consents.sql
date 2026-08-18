CREATE TABLE kai_auth_consent_attempts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  attempt_id uuid NOT NULL,
  payload_digest text NOT NULL CHECK (char_length(payload_digest) BETWEEN 16 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, attempt_id)
);
CREATE INDEX kai_auth_consent_attempts_user_created
  ON kai_auth_consent_attempts(user_id, created_at DESC);
