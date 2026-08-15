-- Authenticated software-node enrollment. Ed25519 proves possession of the
-- sidecar software key and message continuity. GPU UUID/model/memory remain
-- sidecar-reported facts checked against the reviewed resource snapshot; this
-- is not TPM, NVIDIA NRAS, or manufacturer hardware remote attestation.
ALTER TABLE compute_resources
  ADD CONSTRAINT compute_resources_asset_identity_unique UNIQUE (id, asset_id, supplier_id);

CREATE TABLE asset_deployments (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  status text NOT NULL CHECK (status IN ('claim_issued', 'node_bound', 'revoked')),
  expected_policy_digest text NOT NULL CHECK (expected_policy_digest ~ '^sha256:[a-f0-9]{64}$'),
  -- Key rotation needs a separate stable cross-version identity design. The
  -- first production protocol therefore pins one key version fail-closed.
  gpu_fingerprint_key_version integer NOT NULL CHECK (gpu_fingerprint_key_version = 1),
  blocker_code text CHECK (blocker_code IS NULL OR blocker_code IN (
    'CLAIM_EXPIRED', 'CLAIM_CONFLICT', 'KEY_PROOF_INVALID', 'CLOCK_INVALID',
    'INVENTORY_INVALID', 'INVENTORY_MISMATCH', 'GPU_COUNT_MISMATCH',
    'GPU_MODEL_MISMATCH', 'GPU_MEMORY_MISMATCH', 'POLICY_MISMATCH',
    'RUNTIME_MISMATCH', 'AGENT_VERSION_MISMATCH',
    'GPU_ALREADY_CLAIMED', 'HEARTBEAT_REPLAY', 'HEARTBEAT_SIGNATURE_INVALID'
  )),
  node_id uuid UNIQUE REFERENCES compute_nodes(id),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  bound_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (asset_id, supplier_id) REFERENCES compute_assets(id, supplier_id),
  FOREIGN KEY (resource_id, asset_id, supplier_id)
    REFERENCES compute_resources(id, asset_id, supplier_id),
  UNIQUE (asset_id, generation),
  CHECK (
    (status = 'claim_issued' AND node_id IS NULL AND bound_at IS NULL AND revoked_at IS NULL)
    OR (status = 'node_bound' AND node_id IS NOT NULL AND bound_at IS NOT NULL AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL
      AND ((node_id IS NULL AND bound_at IS NULL) OR (node_id IS NOT NULL AND bound_at IS NOT NULL)))
  )
);
CREATE UNIQUE INDEX asset_deployments_one_current_asset
  ON asset_deployments(asset_id) WHERE status <> 'revoked';
CREATE INDEX asset_deployments_supplier_status
  ON asset_deployments(supplier_id, status, updated_at DESC);

CREATE TABLE compute_node_claims (
  id uuid PRIMARY KEY,
  deployment_id uuid NOT NULL REFERENCES asset_deployments(id),
  generation integer NOT NULL CHECK (generation > 0),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  token_ciphertext text NOT NULL CHECK (token_ciphertext ~ '^[A-Za-z0-9_-]{40,240}$'),
  token_nonce text NOT NULL CHECK (token_nonce ~ '^[A-Za-z0-9_-]{16}$'),
  token_key_version integer NOT NULL CHECK (token_key_version = 1),
  challenge text NOT NULL CHECK (challenge ~ '^[A-Za-z0-9_-]{32,120}$'),
  issued_by_user_id uuid NOT NULL REFERENCES users(id),
  client_request_id text NOT NULL CHECK (char_length(client_request_id) BETWEEN 16 AND 120),
  request_payload_digest text NOT NULL CHECK (char_length(request_payload_digest) BETWEEN 16 AND 160),
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'consumed', 'revoked')),
  expires_at timestamptz NOT NULL,
  consumed_payload_digest text CHECK (
    consumed_payload_digest IS NULL OR consumed_payload_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  consumed_node_id uuid REFERENCES compute_nodes(id),
  consumed_binding_id uuid REFERENCES compute_resource_bindings(id),
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deployment_id, generation),
  UNIQUE (issued_by_user_id, client_request_id),
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + interval '30 minutes'),
  CHECK (
    (status = 'issued' AND consumed_payload_digest IS NULL AND consumed_node_id IS NULL
      AND consumed_binding_id IS NULL AND consumed_at IS NULL AND revoked_at IS NULL)
    OR (status = 'consumed' AND consumed_payload_digest IS NOT NULL AND consumed_node_id IS NOT NULL
      AND consumed_binding_id IS NOT NULL AND consumed_at IS NOT NULL AND revoked_at IS NULL)
    OR (status = 'revoked' AND consumed_payload_digest IS NULL AND consumed_node_id IS NULL
      AND consumed_binding_id IS NULL AND consumed_at IS NULL AND revoked_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX compute_node_claims_one_outstanding
  ON compute_node_claims(deployment_id) WHERE status = 'issued';
CREATE INDEX compute_node_claims_expiry
  ON compute_node_claims(expires_at, id) WHERE status = 'issued';

CREATE FUNCTION protect_compute_node_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'node claims cannot be deleted'; END IF;
  IF NEW.id <> OLD.id OR NEW.deployment_id <> OLD.deployment_id OR NEW.generation <> OLD.generation
    OR NEW.token_hash <> OLD.token_hash OR NEW.token_ciphertext <> OLD.token_ciphertext
    OR NEW.token_nonce <> OLD.token_nonce OR NEW.token_key_version <> OLD.token_key_version
    OR NEW.challenge <> OLD.challenge
    OR NEW.issued_by_user_id <> OLD.issued_by_user_id OR NEW.client_request_id <> OLD.client_request_id
    OR NEW.request_payload_digest <> OLD.request_payload_digest
    OR NEW.expires_at <> OLD.expires_at OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'node claim identity is immutable';
  END IF;
  IF OLD.status = 'issued' AND NEW.status NOT IN ('consumed', 'revoked') THEN
    RAISE EXCEPTION 'invalid node claim transition';
  END IF;
  IF OLD.status IN ('consumed', 'revoked') THEN RAISE EXCEPTION 'terminal node claim is immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER compute_node_claims_guard
  BEFORE UPDATE OR DELETE ON compute_node_claims FOR EACH ROW EXECUTE FUNCTION protect_compute_node_claim();

ALTER TABLE compute_nodes
  ADD COLUMN deployment_id uuid UNIQUE REFERENCES asset_deployments(id),
  ADD COLUMN expected_policy_digest text CHECK (
    expected_policy_digest IS NULL OR expected_policy_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  ADD COLUMN attested_policy_digest text CHECK (
    attested_policy_digest IS NULL OR attested_policy_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  ADD COLUMN runtime_digest text CHECK (
    runtime_digest IS NULL OR runtime_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  ADD COLUMN expected_runtime_digest text CHECK (
    expected_runtime_digest IS NULL OR expected_runtime_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  ADD COLUMN attested_runtime_digest text CHECK (
    attested_runtime_digest IS NULL OR attested_runtime_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  ADD COLUMN expected_agent_version text CHECK (
    expected_agent_version IS NULL OR expected_agent_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'
  ),
  ADD COLUMN agent_version text CHECK (
    agent_version IS NULL OR agent_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'
  ),
  ADD COLUMN heartbeat_observed_at timestamptz;

-- 0039 made these identities unique for all history. Revoked nodes are kept as
-- immutable evidence, but an explicit revoke must release both identities so
-- the same physical node and its stable key can be enrolled again.
ALTER TABLE compute_nodes DROP CONSTRAINT compute_nodes_node_key_fingerprint_key;
ALTER TABLE compute_nodes DROP CONSTRAINT compute_nodes_inventory_digest_key;
CREATE UNIQUE INDEX compute_nodes_one_live_key
  ON compute_nodes(node_key_fingerprint) WHERE status <> 'revoked';
CREATE UNIQUE INDEX compute_nodes_one_live_inventory
  ON compute_nodes(inventory_digest) WHERE status <> 'revoked';

-- A binding exists after key proof, but policy attestation is not a fact until
-- the first valid signed heartbeat arrives.
ALTER TABLE compute_resource_bindings ALTER COLUMN attested_policy_digest DROP NOT NULL;

CREATE TABLE compute_node_boots (
  node_id uuid NOT NULL REFERENCES compute_nodes(id),
  boot_id uuid NOT NULL,
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  last_sequence bigint NOT NULL CHECK (last_sequence > 0),
  last_payload_digest text NOT NULL CHECK (last_payload_digest ~ '^sha256:[a-f0-9]{64}$'),
  last_signature text NOT NULL CHECK (last_signature ~ '^ed25519:[A-Za-z0-9+/=]{40,160}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, boot_id),
  CHECK (last_observed_at >= first_observed_at)
);

CREATE FUNCTION protect_compute_node_boot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'node boot history cannot be deleted'; END IF;
  IF NEW.node_id <> OLD.node_id OR NEW.boot_id <> OLD.boot_id
    OR NEW.first_observed_at <> OLD.first_observed_at OR NEW.created_at <> OLD.created_at
    OR NEW.last_sequence < OLD.last_sequence OR NEW.last_observed_at < OLD.last_observed_at THEN
    RAISE EXCEPTION 'invalid node boot history mutation';
  END IF;
  IF NEW.last_sequence = OLD.last_sequence AND (
    NEW.last_observed_at <> OLD.last_observed_at OR NEW.last_payload_digest <> OLD.last_payload_digest
      OR NEW.last_signature <> OLD.last_signature
  ) THEN RAISE EXCEPTION 'same node boot sequence must be an exact retry'; END IF;
  IF NEW.last_sequence > OLD.last_sequence AND NEW.last_observed_at <= OLD.last_observed_at THEN
    RAISE EXCEPTION 'node boot observations must advance';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER compute_node_boots_guard
  BEFORE UPDATE OR DELETE ON compute_node_boots FOR EACH ROW EXECUTE FUNCTION protect_compute_node_boot();

CREATE TABLE compute_node_gpus (
  node_id uuid NOT NULL REFERENCES compute_nodes(id),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  fingerprint_key_version integer NOT NULL CHECK (fingerprint_key_version = 1),
  gpu_uuid_fingerprint text NOT NULL CHECK (gpu_uuid_fingerprint ~ '^[a-f0-9]{64}$'),
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, ordinal)
);
CREATE UNIQUE INDEX compute_node_gpus_one_live_owner
  ON compute_node_gpus(gpu_uuid_fingerprint) WHERE released_at IS NULL;

CREATE FUNCTION protect_compute_node_gpu() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE node_status text; deployment_status text; binding_count bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'node GPU identities cannot be deleted'; END IF;
  IF NEW.node_id <> OLD.node_id OR NEW.ordinal <> OLD.ordinal
    OR NEW.fingerprint_key_version <> OLD.fingerprint_key_version
    OR NEW.gpu_uuid_fingerprint <> OLD.gpu_uuid_fingerprint OR NEW.created_at <> OLD.created_at
    OR OLD.released_at IS NOT NULL OR NEW.released_at IS NULL THEN
    RAISE EXCEPTION 'invalid node GPU identity mutation';
  END IF;
  SELECT n.status,d.status INTO node_status,deployment_status
    FROM compute_nodes n JOIN asset_deployments d ON d.id=n.deployment_id WHERE n.id=OLD.node_id;
  SELECT count(*) INTO binding_count FROM compute_resource_bindings
    WHERE node_id=OLD.node_id AND status<>'revoked';
  IF node_status IS DISTINCT FROM 'revoked' OR deployment_status IS DISTINCT FROM 'revoked' OR binding_count <> 0 THEN
    RAISE EXCEPTION 'node GPU cannot be released before deployment, node, and bindings are revoked';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER compute_node_gpus_guard
  BEFORE UPDATE OR DELETE ON compute_node_gpus FOR EACH ROW EXECUTE FUNCTION protect_compute_node_gpu();

CREATE FUNCTION protect_compute_node_enrollment_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE deployment_status text; deployment_blocker text; binding_count bigint; gpu_count bigint; boot_count bigint;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'ready' THEN
    RAISE EXCEPTION 'compute nodes must be inserted checking before ready facts are recorded';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR NEW.supplier_id <> OLD.supplier_id OR NEW.provider_key <> OLD.provider_key
      OR NEW.node_public_key <> OLD.node_public_key OR NEW.node_key_fingerprint <> OLD.node_key_fingerprint
      OR NEW.inventory_digest <> OLD.inventory_digest
      OR NEW.deployment_id IS DISTINCT FROM OLD.deployment_id
      OR NEW.expected_policy_digest IS DISTINCT FROM OLD.expected_policy_digest
      OR NEW.expected_runtime_digest IS DISTINCT FROM OLD.expected_runtime_digest
      OR NEW.expected_agent_version IS DISTINCT FROM OLD.expected_agent_version THEN
      RAISE EXCEPTION 'compute node enrollment identity is immutable';
    END IF;
  END IF;
  SELECT status,blocker_code INTO deployment_status,deployment_blocker FROM asset_deployments WHERE id=NEW.deployment_id;
  SELECT count(*) INTO binding_count FROM compute_resource_bindings
    WHERE node_id=NEW.id AND status<>'revoked';
  IF TG_OP = 'UPDATE' AND OLD.status <> 'revoked' AND NEW.status = 'revoked'
    AND (deployment_status IS DISTINCT FROM 'revoked' OR binding_count <> 0) THEN
    RAISE EXCEPTION 'compute node cannot be revoked before deployment and bindings';
  END IF;
  IF NEW.status <> 'revoked' AND deployment_status = 'revoked' THEN
    RAISE EXCEPTION 'active compute node requires active deployment';
  END IF;
  IF NEW.status = 'ready' THEN
    SELECT count(*) INTO gpu_count FROM compute_node_gpus WHERE node_id=NEW.id AND released_at IS NULL;
    SELECT count(*) INTO boot_count FROM compute_node_boots WHERE node_id=NEW.id
      AND boot_id=NEW.heartbeat_boot_id AND last_sequence=NEW.heartbeat_sequence
      AND last_payload_digest=NEW.heartbeat_payload_digest AND last_signature=NEW.heartbeat_signature;
    IF deployment_status IS DISTINCT FROM 'node_bound' OR deployment_blocker IS NOT NULL
      OR binding_count = 0 OR gpu_count = 0 OR boot_count <> 1
      OR NEW.expected_policy_digest IS NULL
      OR NEW.attested_policy_digest IS DISTINCT FROM NEW.expected_policy_digest
      OR NEW.expected_runtime_digest IS NULL
      OR NEW.attested_runtime_digest IS DISTINCT FROM NEW.expected_runtime_digest
      OR NEW.runtime_digest IS DISTINCT FROM NEW.attested_runtime_digest
      OR NEW.expected_agent_version IS NULL OR NEW.agent_version IS DISTINCT FROM NEW.expected_agent_version THEN
      RAISE EXCEPTION 'compute node ready facts are incomplete or inconsistent (deployment %, blocker %, bindings %, GPUs %, boot %, policy %, runtime %, agent %)',
        deployment_status,deployment_blocker,binding_count,gpu_count,boot_count,
        (NEW.attested_policy_digest IS NOT DISTINCT FROM NEW.expected_policy_digest),
        (NEW.attested_runtime_digest IS NOT DISTINCT FROM NEW.expected_runtime_digest),
        (NEW.agent_version IS NOT DISTINCT FROM NEW.expected_agent_version);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER compute_nodes_enrollment_identity_guard
  BEFORE INSERT OR UPDATE ON compute_nodes FOR EACH ROW EXECUTE FUNCTION protect_compute_node_enrollment_identity();

CREATE FUNCTION protect_compute_binding_ready_facts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE valid_count bigint; enrolled boolean;
BEGIN
  SELECT deployment_id IS NOT NULL INTO enrolled FROM compute_nodes WHERE id=NEW.node_id;
  IF NEW.status='ready' AND enrolled THEN
    SELECT count(*) INTO valid_count FROM compute_nodes n
      JOIN asset_deployments d ON d.id=n.deployment_id AND d.node_id=n.id
      JOIN compute_node_boots boot ON boot.node_id=n.id AND boot.boot_id=n.heartbeat_boot_id
        AND boot.last_sequence=n.heartbeat_sequence AND boot.last_payload_digest=n.heartbeat_payload_digest
        AND boot.last_signature=n.heartbeat_signature
      WHERE n.id=NEW.node_id AND n.status='ready' AND d.status='node_bound' AND d.blocker_code IS NULL
        AND NEW.policy_digest=d.expected_policy_digest
        AND NEW.attested_policy_digest=NEW.policy_digest
        AND NEW.inventory_digest=n.inventory_digest
        AND n.attested_policy_digest=n.expected_policy_digest
        AND n.attested_runtime_digest=n.expected_runtime_digest
        AND n.runtime_digest=n.attested_runtime_digest
        AND n.agent_version=n.expected_agent_version
        AND EXISTS (SELECT 1 FROM compute_node_gpus gpu WHERE gpu.node_id=n.id AND gpu.released_at IS NULL);
    IF valid_count <> 1 THEN RAISE EXCEPTION 'compute binding ready facts are incomplete or inconsistent'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER compute_resource_bindings_ready_guard
  BEFORE INSERT OR UPDATE ON compute_resource_bindings FOR EACH ROW EXECUTE FUNCTION protect_compute_binding_ready_facts();

CREATE FUNCTION protect_asset_deployment_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'asset deployments cannot be deleted'; END IF;
  IF NEW.id <> OLD.id OR NEW.asset_id <> OLD.asset_id OR NEW.supplier_id <> OLD.supplier_id
    OR NEW.resource_id <> OLD.resource_id OR NEW.generation <> OLD.generation
    OR NEW.expected_policy_digest <> OLD.expected_policy_digest
    OR NEW.gpu_fingerprint_key_version <> OLD.gpu_fingerprint_key_version
    OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'asset deployment identity is immutable';
  END IF;
  IF OLD.status = 'revoked' THEN RAISE EXCEPTION 'revoked asset deployment is immutable'; END IF;
  IF OLD.status = 'claim_issued' AND NEW.status NOT IN ('claim_issued', 'node_bound', 'revoked') THEN
    RAISE EXCEPTION 'invalid asset deployment transition';
  END IF;
  IF OLD.status = 'node_bound' AND NEW.status NOT IN ('node_bound', 'revoked') THEN
    RAISE EXCEPTION 'invalid asset deployment transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER asset_deployments_guard
  BEFORE UPDATE OR DELETE ON asset_deployments FOR EACH ROW EXECUTE FUNCTION protect_asset_deployment_identity();

CREATE TRIGGER asset_deployments_updated_at
  BEFORE UPDATE ON asset_deployments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER compute_node_boots_updated_at
  BEFORE UPDATE ON compute_node_boots FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP VIEW compute_resource_delivery_readiness;
CREATE VIEW compute_resource_delivery_readiness AS
SELECT r.id AS resource_id,
  CASE
    WHEN b.id IS NULL THEN 'unbound'
    WHEN b.status = 'revoked' OR n.status = 'revoked' OR d.status = 'revoked' THEN 'revoked'
    WHEN d.id IS NULL OR d.status <> 'node_bound' OR d.node_id IS DISTINCT FROM n.id
      OR n.deployment_id IS DISTINCT FROM d.id OR d.blocker_code IS NOT NULL
      OR b.status = 'checking' OR n.status = 'checking'
      OR b.resource_verification_digest IS DISTINCT FROM r.verification_digest
      OR b.policy_digest IS DISTINCT FROM d.expected_policy_digest
      OR b.attested_policy_digest IS DISTINCT FROM b.policy_digest
      OR n.expected_policy_digest IS DISTINCT FROM d.expected_policy_digest
      OR n.attested_policy_digest IS DISTINCT FROM n.expected_policy_digest
      OR n.expected_runtime_digest IS NULL
      OR n.attested_runtime_digest IS DISTINCT FROM n.expected_runtime_digest
      OR n.runtime_digest IS DISTINCT FROM n.attested_runtime_digest
      OR n.expected_agent_version IS NULL OR n.agent_version IS DISTINCT FROM n.expected_agent_version
      OR b.inventory_digest IS DISTINCT FROM n.inventory_digest
      OR b.provider_key IS DISTINCT FROM n.provider_key
      OR n.supplier_id IS DISTINCT FROM r.supplier_id THEN 'checking'
    WHEN b.status = 'offline' OR n.status = 'offline' OR n.last_heartbeat_at IS NULL
      OR n.last_heartbeat_at <= now() - interval '2 minutes'
      OR n.last_heartbeat_at > now() + interval '5 seconds' THEN 'offline'
    WHEN b.status = 'ready' AND n.status = 'ready' THEN 'ready'
    ELSE 'checking'
  END AS status,
  n.last_heartbeat_at AS node_last_seen_at
FROM compute_resources r
LEFT JOIN LATERAL (
  SELECT candidate.* FROM compute_resource_bindings candidate
  WHERE candidate.resource_id = r.id
  ORDER BY (candidate.status <> 'revoked') DESC, candidate.generation DESC
  LIMIT 1
) b ON true
LEFT JOIN compute_nodes n ON n.id = b.node_id
LEFT JOIN asset_deployments d ON d.id = n.deployment_id AND d.resource_id = r.id AND d.asset_id = r.asset_id;
