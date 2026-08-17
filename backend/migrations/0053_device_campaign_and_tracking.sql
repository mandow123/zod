ALTER TABLE physical_device_products ADD COLUMN campaign_key text;
ALTER TABLE physical_device_products ADD COLUMN template_key text;
ALTER TABLE physical_device_products ADD COLUMN list_unit_credit_micros bigint;
UPDATE physical_device_products SET
  campaign_key = 'nvidia-dgx-spark-200-baige-20off',
  template_key = 'nvidia-dgx-spark-preorder-v1',
  list_unit_credit_micros = 40668662675
WHERE id = '02672000-0000-4000-8000-000000000200';
ALTER TABLE physical_device_products ALTER COLUMN campaign_key SET NOT NULL;
ALTER TABLE physical_device_products ALTER COLUMN template_key SET NOT NULL;
ALTER TABLE physical_device_products ALTER COLUMN list_unit_credit_micros SET NOT NULL;
ALTER TABLE physical_device_products ADD CONSTRAINT physical_device_products_campaign_key_unique UNIQUE(campaign_key);
ALTER TABLE physical_device_products ADD CONSTRAINT physical_device_products_campaign_key_format
  CHECK (campaign_key ~ '^[a-z0-9][a-z0-9-]{7,79}$');
ALTER TABLE physical_device_products ADD CONSTRAINT physical_device_products_template_key_format
  CHECK (template_key ~ '^[a-z0-9][a-z0-9-]{7,79}$');
ALTER TABLE physical_device_products ADD CONSTRAINT physical_device_products_list_credit_positive
  CHECK (list_unit_credit_micros > unit_credit_micros);
ALTER TABLE physical_device_products ADD CONSTRAINT physical_device_products_credit_discount_exact
  CHECK (unit_credit_micros * 10000 = list_unit_credit_micros * discount_basis_points);

ALTER TABLE physical_device_orders ADD COLUMN campaign_key text;
ALTER TABLE physical_device_orders ADD COLUMN campaign_version text;
UPDATE physical_device_orders o SET campaign_key = p.campaign_key, campaign_version = p.template_key
  FROM physical_device_products p WHERE p.id = o.product_id;
ALTER TABLE physical_device_orders ALTER COLUMN campaign_key SET NOT NULL;
ALTER TABLE physical_device_orders ALTER COLUMN campaign_version SET NOT NULL;
ALTER TABLE physical_device_orders ADD CONSTRAINT physical_device_orders_campaign_key_format
  CHECK (campaign_key ~ '^[a-z0-9][a-z0-9-]{7,79}$');
ALTER TABLE physical_device_orders ADD CONSTRAINT physical_device_orders_campaign_version_format
  CHECK (campaign_version ~ '^[a-z0-9][a-z0-9-]{7,79}$');

ALTER TABLE physical_device_orders ADD COLUMN tracking_ciphertext text
  CHECK (tracking_ciphertext IS NULL OR char_length(tracking_ciphertext) BETWEEN 32 AND 2000);

CREATE FUNCTION protect_physical_device_tracking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.campaign_key IS DISTINCT FROM OLD.campaign_key
    OR NEW.campaign_version IS DISTINCT FROM OLD.campaign_version THEN
    RAISE EXCEPTION 'physical device campaign snapshot is immutable';
  END IF;
  IF OLD.shipped_at IS NOT NULL AND (
    NEW.logistics_provider IS DISTINCT FROM OLD.logistics_provider
    OR NEW.tracking_digest IS DISTINCT FROM OLD.tracking_digest
    OR NEW.tracking_ciphertext IS DISTINCT FROM OLD.tracking_ciphertext
  ) THEN RAISE EXCEPTION 'physical device tracking is immutable after shipment'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER physical_device_orders_tracking_guard BEFORE UPDATE ON physical_device_orders
  FOR EACH ROW EXECUTE FUNCTION protect_physical_device_tracking();
