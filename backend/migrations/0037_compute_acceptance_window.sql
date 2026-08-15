ALTER TABLE compute_fulfillment_acceptances
  ALTER COLUMN accepted_by_user_id DROP NOT NULL,
  ADD COLUMN accepted_actor text NOT NULL DEFAULT 'buyer'
    CHECK (accepted_actor IN ('buyer','system','operator')),
  ADD CONSTRAINT compute_fulfillment_acceptance_actor_identity CHECK (
    (accepted_actor = 'system' AND accepted_by_user_id IS NULL)
    OR (accepted_actor IN ('buyer','operator') AND accepted_by_user_id IS NOT NULL)
  );

UPDATE compute_fulfillment_acceptances a SET accepted_actor = 'operator'
FROM compute_fulfillment_issue_decisions d WHERE d.fulfillment_id = a.fulfillment_id;

ALTER TABLE kai_credit_orders
  DROP CONSTRAINT kai_credit_orders_delivery_times,
  ADD COLUMN accepted_actor text CHECK (accepted_actor IN ('buyer','system','operator'));

UPDATE kai_credit_orders o SET accepted_actor = COALESCE(a.accepted_actor, 'buyer')
FROM compute_fulfillment_acceptances a WHERE a.order_id=o.id AND o.accepted_at IS NOT NULL;
UPDATE kai_credit_orders SET accepted_actor = 'buyer' WHERE accepted_at IS NOT NULL AND accepted_actor IS NULL;

ALTER TABLE kai_credit_orders ADD CONSTRAINT kai_credit_orders_delivery_times CHECK (
    (delivery_ready_at IS NULL OR delivery_started_at IS NOT NULL)
    AND (accepted_at IS NULL OR delivery_ready_at IS NOT NULL)
    AND ((accepted_at IS NULL) = (accepted_actor IS NULL))
    AND (accepted_actor IS NULL OR accepted_actor = 'system' OR accepted_by_user_id IS NOT NULL)
    AND (accepted_actor <> 'system' OR accepted_by_user_id IS NULL)
  );
