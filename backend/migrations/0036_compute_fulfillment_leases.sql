CREATE TABLE compute_fulfillments (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES kai_credit_orders(id),
  buyer_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  supplier_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  resource_id uuid NOT NULL REFERENCES compute_resources(id),
  provider_key text NOT NULL CHECK (char_length(provider_key) BETWEEN 3 AND 80),
  provider_lease_id text,
  status text NOT NULL CHECK (status IN (
    'pending', 'provisioning', 'ready', 'running', 'stopping', 'stopped', 'failed'
  )),
  connection jsonb,
  attestation_digest text,
  failure_code text,
  failure_retryable boolean,
  provisioning_at timestamptz,
  ready_at timestamptz,
  running_at timestamptz,
  stopping_at timestamptz,
  hard_expires_at timestamptz,
  stopped_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (buyer_subject_id <> supplier_subject_id),
  CHECK ((status IN ('ready', 'running', 'stopping', 'stopped')) = (provider_lease_id IS NOT NULL)),
  CHECK ((status IN ('ready', 'running', 'stopping', 'stopped')) = (connection IS NOT NULL)),
  CHECK ((status IN ('ready', 'running', 'stopping', 'stopped')) = (attestation_digest IS NOT NULL)),
  CHECK ((status = 'failed') = (failed_at IS NOT NULL AND failure_code IS NOT NULL AND failure_retryable IS NOT NULL)),
  CHECK (status <> 'ready' OR ready_at IS NOT NULL),
  CHECK (status <> 'running' OR running_at IS NOT NULL),
  CHECK (status <> 'stopping' OR stopping_at IS NOT NULL),
  CHECK (status <> 'stopped' OR stopped_at IS NOT NULL)
);
CREATE INDEX compute_fulfillments_buyer_time ON compute_fulfillments(buyer_subject_id, created_at DESC);
CREATE INDEX compute_fulfillments_supplier_time ON compute_fulfillments(supplier_subject_id, created_at DESC);
CREATE INDEX compute_fulfillments_work ON compute_fulfillments(status, updated_at)
  WHERE status IN ('pending', 'provisioning', 'stopping');

CREATE TABLE compute_access_sessions (
  id uuid PRIMARY KEY,
  fulfillment_id uuid NOT NULL REFERENCES compute_fulfillments(id),
  buyer_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  ticket_digest text NOT NULL CHECK (char_length(ticket_digest) BETWEEN 32 AND 160),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE INDEX compute_access_sessions_lease_time ON compute_access_sessions(fulfillment_id, created_at DESC);

CREATE TABLE compute_fulfillment_metering (
  id uuid PRIMARY KEY,
  fulfillment_id uuid NOT NULL UNIQUE REFERENCES compute_fulfillments(id),
  consumed_capacity_micros bigint NOT NULL CHECK (consumed_capacity_micros >= 0),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^sha256:[a-f0-9]{64}$'),
  stopped_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE compute_fulfillment_acceptances (
  id uuid PRIMARY KEY,
  fulfillment_id uuid NOT NULL UNIQUE REFERENCES compute_fulfillments(id),
  order_id uuid NOT NULL UNIQUE REFERENCES kai_credit_orders(id),
  buyer_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  accepted_by_user_id uuid NOT NULL REFERENCES users(id),
  metering_id uuid NOT NULL UNIQUE REFERENCES compute_fulfillment_metering(id),
  consumed_capacity_micros bigint NOT NULL CHECK (consumed_capacity_micros >= 0),
  captured_credit_micros bigint NOT NULL CHECK (captured_credit_micros >= 0),
  refunded_credit_micros bigint NOT NULL CHECK (refunded_credit_micros >= 0),
  resolution_transaction_id uuid NOT NULL UNIQUE REFERENCES kai_credit_transactions(id),
  accepted_at timestamptz NOT NULL
);

CREATE TABLE compute_fulfillment_issues (
  id uuid PRIMARY KEY,
  fulfillment_id uuid NOT NULL UNIQUE REFERENCES compute_fulfillments(id),
  order_id uuid NOT NULL UNIQUE REFERENCES kai_credit_orders(id),
  buyer_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  opened_by_user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('access', 'metering')),
  description_ciphertext text NOT NULL,
  description_digest text NOT NULL CHECK (char_length(description_digest) BETWEEN 32 AND 160),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  opened_at timestamptz NOT NULL,
  resolved_at timestamptz
);

CREATE TABLE compute_fulfillment_issue_decisions (
  id uuid PRIMARY KEY,
  issue_id uuid NOT NULL UNIQUE REFERENCES compute_fulfillment_issues(id),
  fulfillment_id uuid NOT NULL UNIQUE REFERENCES compute_fulfillments(id),
  order_id uuid NOT NULL UNIQUE REFERENCES kai_credit_orders(id),
  operator_id uuid NOT NULL REFERENCES users(id),
  outcome text NOT NULL CHECK (outcome IN ('full_refund','partial_refund','reject_refund')),
  metered_credit_micros bigint NOT NULL CHECK (metered_credit_micros >= 0),
  remedy_refund_credit_micros bigint NOT NULL CHECK (remedy_refund_credit_micros >= 0),
  provider_credit_micros bigint NOT NULL CHECK (provider_credit_micros >= 0),
  buyer_refund_credit_micros bigint NOT NULL CHECK (buyer_refund_credit_micros >= 0),
  reason_ciphertext text NOT NULL,
  reason_digest text NOT NULL CHECK (char_length(reason_digest) BETWEEN 32 AND 160),
  resolution_transaction_id uuid NOT NULL UNIQUE REFERENCES kai_credit_transactions(id),
  decided_at timestamptz NOT NULL,
  CHECK (remedy_refund_credit_micros <= metered_credit_micros),
  CHECK (provider_credit_micros + remedy_refund_credit_micros = metered_credit_micros),
  CHECK ((outcome = 'full_refund') = (provider_credit_micros = 0)),
  CHECK ((outcome = 'reject_refund') = (remedy_refund_credit_micros = 0))
);

CREATE TABLE compute_fulfillment_issue_decision_requests (
  operator_id uuid NOT NULL REFERENCES users(id),
  client_request_id text NOT NULL CHECK (char_length(client_request_id) BETWEEN 16 AND 120),
  order_id uuid NOT NULL REFERENCES kai_credit_orders(id),
  payload_digest text NOT NULL CHECK (char_length(payload_digest) BETWEEN 16 AND 160),
  decision_id uuid NOT NULL REFERENCES compute_fulfillment_issue_decisions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operator_id,client_request_id)
);

CREATE TABLE compute_fulfillment_supplier_settlements (
  id uuid PRIMARY KEY,
  fulfillment_id uuid NOT NULL UNIQUE REFERENCES compute_fulfillments(id),
  acceptance_id uuid NOT NULL UNIQUE REFERENCES compute_fulfillment_acceptances(id),
  order_id uuid NOT NULL UNIQUE REFERENCES kai_credit_orders(id),
  supplier_subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  credit_micros bigint NOT NULL CHECK (credit_micros >= 0),
  settlement_transaction_id uuid UNIQUE REFERENCES kai_credit_transactions(id),
  available_at timestamptz NOT NULL,
  settled_at timestamptz NOT NULL,
  CHECK ((credit_micros = 0) = (settlement_transaction_id IS NULL)),
  CHECK (settled_at >= available_at)
);

CREATE TABLE compute_fulfillment_events (
  id uuid PRIMARY KEY,
  fulfillment_id uuid NOT NULL REFERENCES compute_fulfillments(id),
  actor_id uuid REFERENCES users(id),
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'provider', 'system')),
  event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 3 AND 80),
  from_status text,
  to_status text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX compute_fulfillment_events_timeline ON compute_fulfillment_events(fulfillment_id, created_at, id);

CREATE FUNCTION protect_compute_fulfillment_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.order_id <> OLD.order_id OR NEW.buyer_subject_id <> OLD.buyer_subject_id
    OR NEW.supplier_subject_id <> OLD.supplier_subject_id OR NEW.resource_id <> OLD.resource_id
    OR NEW.provider_key <> OLD.provider_key OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'compute fulfillment identity is immutable';
  END IF;
  IF OLD.status IN ('stopped', 'failed') THEN
    RAISE EXCEPTION 'terminal compute fulfillment is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION protect_kai_credit_order_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.order_number <> OLD.order_number
    OR NEW.buyer_subject_id <> OLD.buyer_subject_id OR NEW.supplier_subject_id <> OLD.supplier_subject_id
    OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.listing_id <> OLD.listing_id
    OR NEW.client_request_id <> OLD.client_request_id OR NEW.payload_digest <> OLD.payload_digest
    OR NEW.quantity <> OLD.quantity OR NEW.capacity_unit <> OLD.capacity_unit
    OR NEW.unit_credit_micros <> OLD.unit_credit_micros OR NEW.total_credit_micros <> OLD.total_credit_micros
    OR NEW.listing_snapshot <> OLD.listing_snapshot OR NEW.reservation_expires_at <> OLD.reservation_expires_at
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'kai credit order identity is immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'reserved' AND NEW.status IN ('confirmed', 'cancelled', 'expired'))
    OR (OLD.status = 'confirmed' AND NEW.status = 'provisioning')
    OR (OLD.status = 'provisioning' AND NEW.status IN ('ready', 'acceptance_pending', 'refunded'))
    OR (OLD.status = 'ready' AND NEW.status IN ('in_service', 'release_pending', 'refunded'))
    OR (OLD.status = 'in_service' AND NEW.status = 'release_pending')
    OR (OLD.status = 'release_pending' AND NEW.status = 'acceptance_pending')
    OR (OLD.status = 'acceptance_pending' AND NEW.status IN ('accepted', 'disputed'))
    OR (OLD.status = 'disputed' AND NEW.status IN ('provisioning', 'accepted', 'refunded'))
    OR (OLD.status = 'accepted' AND NEW.status IN ('closed', 'refunded'))
  ) THEN RAISE EXCEPTION 'invalid kai credit order transition'; END IF;
  IF OLD.confirmed_at IS NOT NULL AND (
    NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at OR NEW.confirmed_by_user_id IS DISTINCT FROM OLD.confirmed_by_user_id
  ) THEN RAISE EXCEPTION 'kai credit order confirmation is immutable'; END IF;
  IF OLD.accepted_at IS NOT NULL AND (
    NEW.accepted_at IS DISTINCT FROM OLD.accepted_at OR NEW.accepted_by_user_id IS DISTINCT FROM OLD.accepted_by_user_id
  ) THEN RAISE EXCEPTION 'kai credit order acceptance is immutable'; END IF;
  IF OLD.closed_at IS NOT NULL AND NEW.closed_at IS DISTINCT FROM OLD.closed_at THEN
    RAISE EXCEPTION 'kai credit order closure is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION require_kai_credit_supplier_settlement_for_closed_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'closed' AND NOT EXISTS (
    SELECT 1 FROM kai_credit_supplier_settlements s WHERE s.order_id = NEW.id
  ) AND NOT EXISTS (
    SELECT 1 FROM compute_fulfillment_supplier_settlements s WHERE s.order_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'closed kai credit order requires supplier settlement';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION require_kai_credit_active_issue_for_disputed_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'disputed' AND NOT EXISTS (
    SELECT 1 FROM kai_credit_order_delivery_issues i
      WHERE i.order_id = NEW.id AND i.status IN ('open', 'escalated')
  ) AND NOT EXISTS (
    SELECT 1 FROM compute_fulfillment_issues i
      WHERE i.order_id = NEW.id AND i.status = 'open'
  ) THEN RAISE EXCEPTION 'disputed kai credit order requires active issue'; END IF;
  RETURN NULL;
END;
$$;

ALTER TABLE kai_credit_orders DROP CONSTRAINT kai_credit_orders_check2;
ALTER TABLE kai_credit_orders ADD CONSTRAINT kai_credit_orders_closure_state CHECK (
  status = 'accepted' OR
  ((status IN ('reserved','confirmed','provisioning','ready','in_service','acceptance_pending',
    'release_pending','refund_pending','disputed')) = (closed_at IS NULL))
);

CREATE OR REPLACE FUNCTION require_kai_credit_refund_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'refunded'
    AND NOT EXISTS (SELECT 1 FROM kai_credit_order_mutual_refunds r WHERE r.order_id = NEW.id)
    AND NOT EXISTS (SELECT 1 FROM kai_credit_order_dispute_decisions d
      WHERE d.order_id = NEW.id AND d.outcome = 'full_refund')
    AND NOT EXISTS (SELECT 1 FROM kai_credit_order_post_acceptance_refunds p
      WHERE p.order_id = NEW.id AND p.status = 'succeeded')
    AND NOT EXISTS (SELECT 1 FROM compute_fulfillment_issue_decisions d
      WHERE d.order_id = NEW.id AND d.outcome = 'full_refund')
    AND NOT EXISTS (SELECT 1 FROM compute_fulfillments f
      WHERE f.order_id = NEW.id AND f.status = 'failed') THEN
    RAISE EXCEPTION 'refunded kai credit order requires refund record';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER compute_fulfillments_identity_guard
  BEFORE UPDATE ON compute_fulfillments FOR EACH ROW EXECUTE FUNCTION protect_compute_fulfillment_identity();
CREATE TRIGGER compute_fulfillments_updated_at
  BEFORE UPDATE ON compute_fulfillments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER compute_fulfillments_no_delete
  BEFORE DELETE ON compute_fulfillments FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER compute_access_sessions_immutable
  BEFORE UPDATE OR DELETE ON compute_access_sessions FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER compute_fulfillment_metering_immutable
  BEFORE UPDATE OR DELETE ON compute_fulfillment_metering FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER compute_fulfillment_acceptances_immutable
  BEFORE UPDATE OR DELETE ON compute_fulfillment_acceptances FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER compute_fulfillment_issues_no_delete
  BEFORE DELETE ON compute_fulfillment_issues FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER compute_fulfillment_issue_decisions_immutable
  BEFORE UPDATE OR DELETE ON compute_fulfillment_issue_decisions FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER compute_fulfillment_issue_decision_requests_immutable
  BEFORE UPDATE OR DELETE ON compute_fulfillment_issue_decision_requests FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER compute_fulfillment_supplier_settlements_immutable
  BEFORE UPDATE OR DELETE ON compute_fulfillment_supplier_settlements FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER compute_fulfillment_events_immutable
  BEFORE UPDATE OR DELETE ON compute_fulfillment_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
