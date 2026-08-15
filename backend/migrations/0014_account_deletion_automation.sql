CREATE INDEX account_deletion_due
  ON account_deletion_requests(cooling_off_until, requested_at)
  WHERE status IN ('cooling_off', 'blocked_by_legal_hold');
