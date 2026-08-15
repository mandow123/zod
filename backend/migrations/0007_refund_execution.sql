CREATE TABLE refund_events (
  id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('alipay', 'wechat')),
  provider_event_id text NOT NULL,
  refund_id uuid REFERENCES refunds(id),
  provider_refund_id text,
  status text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL DEFAULT 'CNY',
  signature_valid boolean NOT NULL,
  payload_digest text NOT NULL,
  normalized_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  processing_error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX refund_events_refund ON refund_events(refund_id, received_at DESC);

ALTER TABLE outbox_events ADD COLUMN dead_lettered_at timestamptz;
CREATE INDEX outbox_dead_letters ON outbox_events(dead_lettered_at, topic)
  WHERE dead_lettered_at IS NOT NULL;

CREATE TRIGGER refund_events_immutable
  BEFORE UPDATE OR DELETE ON refund_events
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
