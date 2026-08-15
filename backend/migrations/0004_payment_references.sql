ALTER TABLE payment_intents ADD COLUMN provider_reference text;
CREATE UNIQUE INDEX payment_intents_provider_reference_unique
  ON payment_intents(provider, provider_reference)
  WHERE provider_reference IS NOT NULL;

ALTER TABLE payment_events ADD COLUMN provider_transaction_id text;
CREATE UNIQUE INDEX payment_events_provider_transaction_unique
  ON payment_events(provider, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;
