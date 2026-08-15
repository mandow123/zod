ALTER TABLE payment_intents
  ADD COLUMN reconciliation_attempts integer NOT NULL DEFAULT 0 CHECK (reconciliation_attempts >= 0),
  ADD COLUMN next_reconcile_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN reconciliation_locked_at timestamptz,
  ADD COLUMN last_reconciled_at timestamptz,
  ADD COLUMN last_provider_status text,
  ADD COLUMN last_reconciliation_error text,
  ADD COLUMN reconciliation_dead_lettered_at timestamptz;

CREATE INDEX payment_intents_reconciliation_queue
  ON payment_intents(next_reconcile_at, created_at)
  WHERE status = 'pending' AND reconciliation_dead_lettered_at IS NULL;
