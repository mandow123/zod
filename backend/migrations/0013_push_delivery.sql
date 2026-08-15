CREATE TABLE push_deliveries (
  id uuid PRIMARY KEY,
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL REFERENCES device_installations(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('ticket_ok', 'delivered', 'failed', 'invalid_device')),
  expo_ticket_id text,
  error_code text,
  receipt_check_after timestamptz,
  receipt_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (notification_id, installation_id),
  UNIQUE (expo_ticket_id)
);

CREATE INDEX push_deliveries_receipts
  ON push_deliveries(receipt_check_after)
  WHERE status = 'ticket_ok' AND receipt_checked_at IS NULL;

CREATE TRIGGER push_deliveries_updated_at
  BEFORE UPDATE ON push_deliveries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
