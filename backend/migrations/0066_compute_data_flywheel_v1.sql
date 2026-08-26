CREATE TABLE compute_data_requests (
  id uuid PRIMARY KEY,
  buyer_subject_id uuid REFERENCES trading_subjects(id),
  source_entity_type text NOT NULL CHECK (char_length(source_entity_type) BETWEEN 1 AND 80),
  source_entity_id text NOT NULL CHECK (char_length(source_entity_id) BETWEEN 1 AND 200),
  requirement jsonb NOT NULL CHECK (jsonb_typeof(requirement) = 'object'),
  parsed_requirement jsonb NOT NULL CHECK (jsonb_typeof(parsed_requirement) = 'object'),
  requirement_version text NOT NULL CHECK (char_length(requirement_version) BETWEEN 1 AND 80),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 80),
  source_version text NOT NULL CHECK (char_length(source_version) BETWEEN 1 AND 80),
  environment text NOT NULL CHECK (environment IN ('production','staging','test','development')),
  data_origin text NOT NULL CHECK (data_origin IN ('business','seed_reference','demo','synthetic')),
  trace_id text CHECK (trace_id IS NULL OR char_length(trace_id) BETWEEN 1 AND 160),
  UNIQUE (source, source_entity_type, source_entity_id),
  CHECK (occurred_at <= recorded_at + interval '5 minutes')
);
CREATE INDEX compute_data_requests_occurred ON compute_data_requests(occurred_at, id);
CREATE INDEX compute_data_requests_subject_time
  ON compute_data_requests(buyer_subject_id, occurred_at DESC) WHERE buyer_subject_id IS NOT NULL;

CREATE TABLE compute_ranking_runs (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES compute_data_requests(id),
  source_event_id text NOT NULL CHECK (char_length(source_event_id) BETWEEN 1 AND 200),
  algorithm_version text NOT NULL CHECK (char_length(algorithm_version) BETWEEN 1 AND 120),
  policy_version text NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 120),
  expected_candidate_count integer NOT NULL CHECK (expected_candidate_count BETWEEN 0 AND 10000),
  context jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(context) = 'object'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 80),
  source_version text NOT NULL CHECK (char_length(source_version) BETWEEN 1 AND 80),
  UNIQUE (source, source_event_id),
  UNIQUE (id, request_id),
  CHECK (occurred_at <= recorded_at + interval '5 minutes')
);
CREATE INDEX compute_ranking_runs_request_time ON compute_ranking_runs(request_id, occurred_at, id);

CREATE TABLE compute_ranking_candidates (
  ranking_run_id uuid NOT NULL,
  request_id uuid NOT NULL,
  candidate_key text NOT NULL CHECK (char_length(candidate_key) BETWEEN 1 AND 200),
  resource_id uuid,
  supplier_id uuid,
  listing_id uuid,
  feature_snapshot jsonb NOT NULL CHECK (jsonb_typeof(feature_snapshot) = 'object'),
  score numeric(24,6) NOT NULL,
  component_scores jsonb NOT NULL CHECK (jsonb_typeof(component_scores) = 'object'),
  rank_position integer NOT NULL CHECK (rank_position BETWEEN 1 AND 10000),
  eligible boolean NOT NULL,
  rejection_reasons jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(rejection_reasons) = 'array'),
  listed_price_micros bigint CHECK (listed_price_micros IS NULL OR listed_price_micros >= 0),
  quoted_price_micros bigint CHECK (quoted_price_micros IS NULL OR quoted_price_micros >= 0),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3,12}$'),
  quantity numeric(24,6) CHECK (quantity IS NULL OR quantity > 0),
  duration_seconds bigint CHECK (duration_seconds IS NULL OR duration_seconds > 0),
  availability_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(availability_snapshot) = 'object'),
  sla_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(sla_snapshot) = 'object'),
  price_observed_at timestamptz,
  inventory_observed_at timestamptz,
  captured_at timestamptz NOT NULL,
  data_origin text NOT NULL CHECK (data_origin IN ('business','seed_reference','demo','synthetic')),
  PRIMARY KEY (ranking_run_id, candidate_key),
  UNIQUE (ranking_run_id, rank_position),
  FOREIGN KEY (ranking_run_id, request_id) REFERENCES compute_ranking_runs(id, request_id),
  CHECK (eligible OR jsonb_array_length(rejection_reasons) > 0),
  CHECK (price_observed_at IS NULL OR price_observed_at <= captured_at + interval '5 minutes'),
  CHECK (inventory_observed_at IS NULL OR inventory_observed_at <= captured_at + interval '5 minutes')
);
CREATE INDEX compute_ranking_candidates_request_rank
  ON compute_ranking_candidates(request_id, ranking_run_id, rank_position);
CREATE INDEX compute_ranking_candidates_supplier_time
  ON compute_ranking_candidates(supplier_id, captured_at DESC) WHERE supplier_id IS NOT NULL;

CREATE TABLE compute_journey_events (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  ranking_run_id uuid NOT NULL,
  candidate_key text,
  event_name text NOT NULL CHECK (event_name IN (
    'viewed','clicked','selected','quote_created','quote_accepted',
    'reservation_succeeded','reservation_failed',
    'provisioning_started','provisioning_succeeded','provisioning_failed',
    'fulfillment_started','fulfillment_completed','sla_violated',
    'telemetry_observed','settlement_completed','failed',
    'refund_requested','refunded','feedback_submitted'
  )),
  source_event_id text NOT NULL CHECK (char_length(source_event_id) BETWEEN 1 AND 200),
  quote_id text CHECK (quote_id IS NULL OR char_length(quote_id) BETWEEN 1 AND 200),
  reservation_id text CHECK (reservation_id IS NULL OR char_length(reservation_id) BETWEEN 1 AND 200),
  order_id text CHECK (order_id IS NULL OR char_length(order_id) BETWEEN 1 AND 200),
  fulfillment_id text CHECK (fulfillment_id IS NULL OR char_length(fulfillment_id) BETWEEN 1 AND 200),
  settlement_id text CHECK (settlement_id IS NULL OR char_length(settlement_id) BETWEEN 1 AND 200),
  refund_id text CHECK (refund_id IS NULL OR char_length(refund_id) BETWEEN 1 AND 200),
  accepted_price_micros bigint CHECK (accepted_price_micros IS NULL OR accepted_price_micros >= 0),
  final_cost_micros bigint CHECK (final_cost_micros IS NULL OR final_cost_micros >= 0),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3,12}$'),
  latency_ms bigint CHECK (latency_ms IS NULL OR latency_ms >= 0),
  reason_code text CHECK (reason_code IS NULL OR char_length(reason_code) BETWEEN 1 AND 120),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 80),
  source_version text NOT NULL CHECK (char_length(source_version) BETWEEN 1 AND 80),
  data_origin text NOT NULL CHECK (data_origin IN ('business','demo','synthetic')),
  trace_id text CHECK (trace_id IS NULL OR char_length(trace_id) BETWEEN 1 AND 160),
  UNIQUE (source, source_event_id),
  FOREIGN KEY (ranking_run_id, request_id) REFERENCES compute_ranking_runs(id, request_id),
  FOREIGN KEY (ranking_run_id, candidate_key)
    REFERENCES compute_ranking_candidates(ranking_run_id, candidate_key),
  CHECK (occurred_at <= recorded_at + interval '5 minutes'),
  CHECK (event_name NOT IN ('failed','reservation_failed','provisioning_failed','sla_violated')
    OR reason_code IS NOT NULL),
  CHECK (event_name <> 'quote_accepted' OR accepted_price_micros IS NOT NULL),
  CHECK (event_name <> 'settlement_completed' OR final_cost_micros IS NOT NULL),
  CHECK (event_name <> 'selected' OR candidate_key IS NOT NULL)
);
CREATE UNIQUE INDEX compute_journey_single_selection
  ON compute_journey_events(ranking_run_id) WHERE event_name = 'selected';
CREATE INDEX compute_journey_events_timeline
  ON compute_journey_events(request_id, occurred_at, recorded_at, id);
CREATE INDEX compute_journey_events_candidate
  ON compute_journey_events(ranking_run_id, candidate_key, occurred_at)
  WHERE candidate_key IS NOT NULL;
CREATE INDEX compute_journey_events_supplier_labels
  ON compute_journey_events(event_name, occurred_at);

CREATE TRIGGER compute_data_requests_immutable
  BEFORE UPDATE OR DELETE ON compute_data_requests FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER compute_ranking_runs_immutable
  BEFORE UPDATE OR DELETE ON compute_ranking_runs FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER compute_ranking_candidates_immutable
  BEFORE UPDATE OR DELETE ON compute_ranking_candidates FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER compute_journey_events_immutable
  BEFORE UPDATE OR DELETE ON compute_journey_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE VIEW compute_training_dataset_v1 AS
SELECT
  request.id AS request_id,
  run.id AS ranking_run_id,
  candidate.candidate_key,
  candidate.resource_id,
  candidate.supplier_id,
  candidate.listing_id,
  request.occurred_at AS demand_occurred_at,
  request.parsed_requirement,
  request.requirement_version,
  request.environment,
  request.data_origin AS request_data_origin,
  run.algorithm_version,
  run.policy_version,
  run.context AS ranking_context,
  run.expected_candidate_count,
  candidate.feature_snapshot,
  candidate.score::text AS score,
  candidate.component_scores,
  candidate.rank_position,
  candidate.eligible,
  candidate.rejection_reasons,
  candidate.listed_price_micros::text AS listed_price_micros,
  candidate.quoted_price_micros::text AS quoted_price_micros,
  candidate.currency,
  candidate.quantity::text AS quantity,
  candidate.duration_seconds::text AS duration_seconds,
  candidate.availability_snapshot,
  candidate.sla_snapshot,
  candidate.price_observed_at,
  candidate.inventory_observed_at,
  candidate.captured_at,
  candidate.data_origin AS candidate_data_origin,
  outcome.viewed,
  outcome.clicked,
  outcome.selected,
  outcome.quote_accepted,
  outcome.reservation_success,
  outcome.reservation_failure,
  outcome.provisioning_success,
  outcome.provisioning_failure,
  outcome.completion,
  outcome.sla_violation,
  outcome.failure,
  outcome.refund,
  outcome.failure_reason_codes,
  outcome.latency_ms,
  outcome.accepted_price_micros,
  outcome.final_cost_micros,
  telemetry.telemetry_observation_count,
  telemetry.first_telemetry_at,
  telemetry.last_telemetry_at,
  telemetry.latest_telemetry_payload,
  feedback.latest_feedback_payload
FROM compute_data_requests request
JOIN compute_ranking_runs run ON run.request_id = request.id
JOIN compute_ranking_candidates candidate ON candidate.ranking_run_id = run.id
LEFT JOIN LATERAL (
  SELECT
    coalesce(bool_or(event.event_name = 'viewed'), false) AS viewed,
    coalesce(bool_or(event.event_name = 'clicked'), false) AS clicked,
    coalesce(bool_or(event.event_name = 'selected'), false) AS selected,
    coalesce(bool_or(event.event_name = 'quote_accepted'), false) AS quote_accepted,
    coalesce(bool_or(event.event_name = 'reservation_succeeded'), false) AS reservation_success,
    coalesce(bool_or(event.event_name = 'reservation_failed'), false) AS reservation_failure,
    coalesce(bool_or(event.event_name = 'provisioning_succeeded'), false) AS provisioning_success,
    coalesce(bool_or(event.event_name = 'provisioning_failed'), false) AS provisioning_failure,
    coalesce(bool_or(event.event_name = 'fulfillment_completed'), false) AS completion,
    coalesce(bool_or(event.event_name = 'sla_violated'), false) AS sla_violation,
    coalesce(bool_or(event.event_name IN ('failed','reservation_failed','provisioning_failed')), false) AS failure,
    coalesce(bool_or(event.event_name = 'refunded'), false) AS refund,
    coalesce(jsonb_agg(DISTINCT event.reason_code) FILTER (WHERE event.reason_code IS NOT NULL), '[]'::jsonb)
      AS failure_reason_codes,
    max(event.latency_ms)::text AS latency_ms,
    max(event.accepted_price_micros)::text AS accepted_price_micros,
    max(event.final_cost_micros)::text AS final_cost_micros
  FROM compute_journey_events event
  WHERE event.ranking_run_id = candidate.ranking_run_id
    AND event.candidate_key = candidate.candidate_key
) outcome ON true
LEFT JOIN LATERAL (
  SELECT
    count(*)::text AS telemetry_observation_count,
    min(event.occurred_at) AS first_telemetry_at,
    max(event.occurred_at) AS last_telemetry_at,
    (array_agg(event.payload ORDER BY event.occurred_at DESC, event.recorded_at DESC, event.id DESC))[1]
      AS latest_telemetry_payload
  FROM compute_journey_events event
  WHERE event.ranking_run_id = candidate.ranking_run_id
    AND event.candidate_key = candidate.candidate_key
    AND event.event_name = 'telemetry_observed'
) telemetry ON true
LEFT JOIN LATERAL (
  SELECT event.payload AS latest_feedback_payload
  FROM compute_journey_events event
  WHERE event.ranking_run_id = candidate.ranking_run_id
    AND event.candidate_key = candidate.candidate_key
    AND event.event_name = 'feedback_submitted'
  ORDER BY event.occurred_at DESC, event.recorded_at DESC, event.id DESC
  LIMIT 1
) feedback ON true;

CREATE VIEW compute_data_quality_issues_v1 AS
SELECT
  'CANDIDATE_COUNT_MISMATCH'::text AS issue_code,
  run.request_id,
  run.id AS ranking_run_id,
  NULL::uuid AS event_id,
  jsonb_build_object('expected', run.expected_candidate_count, 'actual', count(candidate.candidate_key)) AS detail
FROM compute_ranking_runs run
LEFT JOIN compute_ranking_candidates candidate ON candidate.ranking_run_id = run.id
GROUP BY run.request_id, run.id, run.expected_candidate_count
HAVING count(candidate.candidate_key) <> run.expected_candidate_count
UNION ALL
SELECT
  'RANKING_BEFORE_DEMAND', run.request_id, run.id, NULL::uuid,
  jsonb_build_object('demandOccurredAt', request.occurred_at, 'rankingOccurredAt', run.occurred_at)
FROM compute_ranking_runs run
JOIN compute_data_requests request ON request.id = run.request_id
WHERE run.occurred_at < request.occurred_at
UNION ALL
SELECT
  'EVENT_BEFORE_RANKING', event.request_id, event.ranking_run_id, event.id,
  jsonb_build_object('rankingOccurredAt', run.occurred_at, 'eventOccurredAt', event.occurred_at)
FROM compute_journey_events event
JOIN compute_ranking_runs run ON run.id = event.ranking_run_id
WHERE event.occurred_at < run.occurred_at
UNION ALL
SELECT
  'QUOTE_ACCEPTED_WITHOUT_QUOTE', event.request_id, event.ranking_run_id, event.id,
  jsonb_build_object('quoteId', event.quote_id)
FROM compute_journey_events event
WHERE event.event_name = 'quote_accepted' AND NOT EXISTS (
  SELECT 1 FROM compute_journey_events prerequisite
  WHERE prerequisite.ranking_run_id = event.ranking_run_id
    AND prerequisite.candidate_key = event.candidate_key
    AND prerequisite.event_name = 'quote_created'
    AND prerequisite.occurred_at <= event.occurred_at
)
UNION ALL
SELECT
  'PROVISIONED_WITHOUT_RESERVATION', event.request_id, event.ranking_run_id, event.id,
  jsonb_build_object('fulfillmentId', event.fulfillment_id)
FROM compute_journey_events event
WHERE event.event_name IN ('provisioning_started','provisioning_succeeded') AND NOT EXISTS (
  SELECT 1 FROM compute_journey_events prerequisite
  WHERE prerequisite.ranking_run_id = event.ranking_run_id
    AND prerequisite.candidate_key = event.candidate_key
    AND prerequisite.event_name = 'reservation_succeeded'
    AND prerequisite.occurred_at <= event.occurred_at
)
UNION ALL
SELECT
  'SETTLED_WITHOUT_COMPLETION', event.request_id, event.ranking_run_id, event.id,
  jsonb_build_object('settlementId', event.settlement_id)
FROM compute_journey_events event
WHERE event.event_name = 'settlement_completed' AND NOT EXISTS (
  SELECT 1 FROM compute_journey_events prerequisite
  WHERE prerequisite.ranking_run_id = event.ranking_run_id
    AND prerequisite.candidate_key = event.candidate_key
    AND prerequisite.event_name = 'fulfillment_completed'
    AND prerequisite.occurred_at <= event.occurred_at
);
