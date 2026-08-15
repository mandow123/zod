CREATE TABLE shipping_addresses (
  id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE CHECK (char_length(reference) BETWEEN 16 AND 120),
  subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  client_request_id text NOT NULL CHECK (char_length(client_request_id) BETWEEN 16 AND 120),
  payload_ciphertext text NOT NULL,
  payload_digest text NOT NULL CHECK (char_length(payload_digest) BETWEEN 16 AND 160),
  is_default boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL)),
  UNIQUE (id, subject_id),
  UNIQUE (subject_id, client_request_id),
  UNIQUE (reference, subject_id)
);
CREATE UNIQUE INDEX shipping_addresses_one_default
  ON shipping_addresses(subject_id) WHERE status = 'active' AND is_default = true;
CREATE INDEX shipping_addresses_subject_time
  ON shipping_addresses(subject_id, created_at DESC, id DESC) WHERE status = 'active';
CREATE TRIGGER shipping_addresses_updated_at BEFORE UPDATE ON shipping_addresses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION protect_shipping_address_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.reference <> OLD.reference OR NEW.subject_id <> OLD.subject_id
    OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.client_request_id <> OLD.client_request_id
    OR NEW.payload_ciphertext <> OLD.payload_ciphertext
    OR NEW.payload_digest <> OLD.payload_digest OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'shipping address identity is immutable';
  END IF;
  IF OLD.status = 'deleted' THEN RAISE EXCEPTION 'deleted shipping address is immutable'; END IF;
  IF NEW.status <> OLD.status AND NEW.status <> 'deleted' THEN RAISE EXCEPTION 'invalid shipping address transition'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER shipping_addresses_guard BEFORE UPDATE ON shipping_addresses
  FOR EACH ROW EXECUTE FUNCTION protect_shipping_address_identity();
CREATE TRIGGER shipping_addresses_no_delete BEFORE DELETE ON shipping_addresses
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
