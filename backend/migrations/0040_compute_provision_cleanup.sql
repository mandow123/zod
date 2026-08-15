-- Persist the deterministic sidecar lease identity before making a provider call so cleanup can always be retried.
ALTER TABLE compute_fulfillments
  ADD COLUMN provisional_provider_lease_id text;
ALTER TABLE compute_fulfillments
  ADD CONSTRAINT compute_fulfillments_provisional_provider_lease_id_length CHECK (
    provisional_provider_lease_id IS NULL OR char_length(provisional_provider_lease_id) BETWEEN 8 AND 200
  );
