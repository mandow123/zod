-- Fail closed until an audited compute resource is bound to a recently seen execution node.
CREATE TABLE compute_nodes (
  id uuid PRIMARY KEY,
  supplier_id uuid NOT NULL REFERENCES supplier_profiles(id),
  provider_key text NOT NULL DEFAULT 'sidecar-v1' CHECK (char_length(provider_key) BETWEEN 3 AND 80),
  node_public_key text NOT NULL CHECK (node_public_key ~ '^ed25519:[A-Za-z0-9+/=]{40,120}$'),
  node_key_fingerprint text NOT NULL UNIQUE CHECK (node_key_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  inventory_digest text NOT NULL UNIQUE CHECK (inventory_digest ~ '^sha256:[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'checking' CHECK (status IN ('checking', 'ready', 'offline', 'revoked')),
  last_heartbeat_at timestamptz,
  heartbeat_boot_id uuid,
  heartbeat_sequence bigint CHECK (heartbeat_sequence IS NULL OR heartbeat_sequence > 0),
  heartbeat_payload_digest text CHECK (heartbeat_payload_digest IS NULL OR heartbeat_payload_digest ~ '^sha256:[a-f0-9]{64}$'),
  heartbeat_signature text CHECK (heartbeat_signature IS NULL OR heartbeat_signature ~ '^ed25519:[A-Za-z0-9+/=]{40,160}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (status <> 'ready' OR (last_heartbeat_at IS NOT NULL AND heartbeat_boot_id IS NOT NULL
    AND heartbeat_sequence IS NOT NULL AND heartbeat_payload_digest IS NOT NULL AND heartbeat_signature IS NOT NULL))
);
CREATE INDEX compute_nodes_supplier_status ON compute_nodes(supplier_id, status, last_heartbeat_at DESC);

CREATE TABLE compute_resource_bindings (
  id uuid PRIMARY KEY,
  resource_id uuid NOT NULL REFERENCES compute_resources(id),
  node_id uuid NOT NULL REFERENCES compute_nodes(id),
  provider_key text NOT NULL DEFAULT 'sidecar-v1' CHECK (char_length(provider_key) BETWEEN 3 AND 80),
  status text NOT NULL DEFAULT 'checking' CHECK (status IN ('checking', 'ready', 'offline', 'revoked')),
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  resource_verification_digest text NOT NULL CHECK (resource_verification_digest ~ '^sha256:[a-f0-9]{64}$'),
  policy_digest text NOT NULL CHECK (policy_digest ~ '^sha256:[a-f0-9]{64}$'),
  attested_policy_digest text NOT NULL CHECK (attested_policy_digest ~ '^sha256:[a-f0-9]{64}$'),
  inventory_digest text NOT NULL CHECK (inventory_digest ~ '^sha256:[a-f0-9]{64}$'),
  gpu_set_digest text NOT NULL CHECK (gpu_set_digest ~ '^sha256:[a-f0-9]{64}$'),
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'ready' OR confirmed_at IS NOT NULL)
);
CREATE INDEX compute_resource_bindings_node_status ON compute_resource_bindings(node_id, status);
CREATE UNIQUE INDEX compute_resource_bindings_generation ON compute_resource_bindings(resource_id, generation);
CREATE UNIQUE INDEX compute_resource_bindings_one_current_resource
  ON compute_resource_bindings(resource_id) WHERE status <> 'revoked';
CREATE UNIQUE INDEX compute_resource_bindings_one_current_node
  ON compute_resource_bindings(node_id) WHERE status <> 'revoked';
CREATE UNIQUE INDEX compute_resource_bindings_one_current_gpu_set
  ON compute_resource_bindings(gpu_set_digest) WHERE status <> 'revoked';

CREATE VIEW compute_resource_delivery_readiness AS
SELECT r.id AS resource_id,
  CASE
    WHEN b.id IS NULL THEN 'unbound'
    WHEN b.status = 'revoked' OR n.status = 'revoked' THEN 'revoked'
    WHEN b.status = 'checking' OR n.status = 'checking'
      OR b.resource_verification_digest IS DISTINCT FROM r.verification_digest
      OR b.attested_policy_digest IS DISTINCT FROM b.policy_digest
      OR b.inventory_digest IS DISTINCT FROM n.inventory_digest
      OR b.provider_key IS DISTINCT FROM n.provider_key
      OR n.supplier_id IS DISTINCT FROM r.supplier_id THEN 'checking'
    WHEN b.status = 'offline' OR n.status = 'offline' OR n.last_heartbeat_at IS NULL
      OR n.last_heartbeat_at <= now() - interval '2 minutes'
      OR n.last_heartbeat_at > now() + interval '30 seconds' THEN 'offline'
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
LEFT JOIN compute_nodes n ON n.id = b.node_id;

CREATE TRIGGER compute_nodes_updated_at
  BEFORE UPDATE ON compute_nodes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER compute_resource_bindings_updated_at
  BEFORE UPDATE ON compute_resource_bindings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
