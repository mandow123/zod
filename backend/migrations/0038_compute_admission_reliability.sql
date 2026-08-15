ALTER TABLE compute_fulfillments
  ADD COLUMN allocated_accelerator_count integer,
  ADD COLUMN resource_slot_limit integer,
  ADD COLUMN provisioning_deadline_at timestamptz;

UPDATE compute_fulfillments f SET
  allocated_accelerator_count = 1,
  resource_slot_limit = 8,
  provisioning_deadline_at = LEAST(
    COALESCE(f.provisioning_at, f.created_at) + interval '5 minutes',
    COALESCE(f.hard_expires_at, COALESCE(f.provisioning_at, f.created_at) + (o.quantity * interval '1 hour')) - interval '1 minute'
  )
FROM kai_credit_orders o WHERE o.id = f.order_id;

ALTER TABLE compute_fulfillments
  ALTER COLUMN allocated_accelerator_count SET NOT NULL,
  ALTER COLUMN resource_slot_limit SET NOT NULL,
  ADD CONSTRAINT compute_fulfillment_single_gpu CHECK (allocated_accelerator_count = 1),
  ADD CONSTRAINT compute_fulfillment_resource_slot_limit CHECK (resource_slot_limit BETWEEN 1 AND 64),
  ADD CONSTRAINT compute_fulfillment_provision_deadline CHECK (
    provisioning_deadline_at IS NOT NULL AND provisioning_deadline_at >= provisioning_at
  );

CREATE INDEX compute_fulfillments_provision_deadline
  ON compute_fulfillments(provisioning_deadline_at, id) WHERE status = 'provisioning';
