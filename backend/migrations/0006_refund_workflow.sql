ALTER TABLE refunds
  ADD COLUMN idempotency_key text,
  ADD COLUMN payload_digest text,
  ADD COLUMN order_status_before_refund text,
  ADD COLUMN review_reason text;

ALTER TABLE refunds DROP CONSTRAINT refunds_status_check;
ALTER TABLE refunds ADD CONSTRAINT refunds_status_check
  CHECK (status IN ('requested', 'reviewing', 'approved', 'provider_pending', 'succeeded', 'rejected', 'cancelled', 'failed'));

CREATE UNIQUE INDEX refunds_request_idempotency
  ON refunds(requested_by, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX refunds_one_active_per_payment
  ON refunds(payment_intent_id)
  WHERE status IN ('requested', 'reviewing', 'approved', 'provider_pending');
