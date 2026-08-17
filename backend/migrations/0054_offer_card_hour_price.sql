ALTER TABLE offer_templates
  ADD COLUMN suggested_unit_credit_micros bigint;

UPDATE offer_templates
SET suggested_unit_credit_micros =
  GREATEST(10000, (
    FLOOR(((suggested_price_cny_micros::numeric * 1000000 / 1002000) + 5000) / 10000) * 10000
  )::bigint)
WHERE suggested_unit_credit_micros IS NULL;

CREATE OR REPLACE FUNCTION maintain_offer_card_hour_price()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.suggested_unit_credit_micros IS NULL THEN
    NEW.suggested_unit_credit_micros :=
      GREATEST(10000, (
        FLOOR(((NEW.suggested_price_cny_micros::numeric * 1000000 / 1002000) + 5000) / 10000) * 10000
      )::bigint);
  ELSIF TG_OP = 'UPDATE'
    AND NEW.suggested_price_cny_micros IS DISTINCT FROM OLD.suggested_price_cny_micros
    AND NEW.suggested_unit_credit_micros IS NOT DISTINCT FROM OLD.suggested_unit_credit_micros THEN
    NEW.suggested_unit_credit_micros :=
      GREATEST(10000, (
        FLOOR(((NEW.suggested_price_cny_micros::numeric * 1000000 / 1002000) + 5000) / 10000) * 10000
      )::bigint);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER offer_templates_maintain_card_hour_price
BEFORE INSERT OR UPDATE OF suggested_price_cny_micros, suggested_unit_credit_micros
ON offer_templates
FOR EACH ROW EXECUTE FUNCTION maintain_offer_card_hour_price();

ALTER TABLE offer_templates
  ALTER COLUMN suggested_unit_credit_micros SET NOT NULL,
  ADD CONSTRAINT offer_templates_suggested_unit_credit_positive
    CHECK (suggested_unit_credit_micros > 0 AND suggested_unit_credit_micros % 10000 = 0);
