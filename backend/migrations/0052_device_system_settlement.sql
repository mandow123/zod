-- System-triggered device settlement is a real ledger action and must be
-- distinguishable from a supplier-triggered action.  The previous constraint
-- required a user id even for a durable worker.
ALTER TABLE physical_device_supplier_settlements
  ADD COLUMN settled_actor_kind text CHECK (settled_actor_kind IN ('user', 'system'));
UPDATE physical_device_supplier_settlements SET settled_actor_kind = 'user'
  WHERE status = 'succeeded';
ALTER TABLE physical_device_supplier_settlements
  DROP CONSTRAINT physical_device_supplier_settlements_check1;
ALTER TABLE physical_device_supplier_settlements
  ADD CONSTRAINT physical_device_supplier_settlements_resolution_check CHECK (
    (status = 'succeeded') = (
      settlement_transaction_id IS NOT NULL AND settled_at IS NOT NULL AND settled_actor_kind IS NOT NULL
      AND ((settled_actor_kind = 'user' AND settled_by_user_id IS NOT NULL)
        OR (settled_actor_kind = 'system' AND settled_by_user_id IS NULL))
    )
  );
