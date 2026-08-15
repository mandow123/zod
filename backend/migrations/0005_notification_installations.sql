ALTER TABLE device_installations
  ADD COLUMN push_token_lookup_hash text,
  ADD COLUMN push_failure_count integer NOT NULL DEFAULT 0 CHECK (push_failure_count >= 0),
  ADD COLUMN last_push_error text,
  ADD COLUMN disabled_at timestamptz;

CREATE UNIQUE INDEX device_installations_push_token_unique
  ON device_installations(push_token_lookup_hash)
  WHERE push_token_lookup_hash IS NOT NULL;

CREATE INDEX device_installations_push_enabled
  ON device_installations(user_id, platform)
  WHERE push_enabled = true AND push_token_ciphertext IS NOT NULL;
