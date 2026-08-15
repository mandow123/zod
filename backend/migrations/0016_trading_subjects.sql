CREATE TABLE trading_subjects (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('personal', 'organization')),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  client_request_id text,
  payload_digest text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK ((client_request_id IS NULL) = (payload_digest IS NULL)),
  CHECK (client_request_id IS NULL OR char_length(client_request_id) BETWEEN 16 AND 120)
);
CREATE UNIQUE INDEX trading_subjects_personal_owner
  ON trading_subjects(owner_user_id) WHERE kind = 'personal' AND status <> 'closed';
CREATE UNIQUE INDEX trading_subjects_creation_request
  ON trading_subjects(owner_user_id, client_request_id) WHERE client_request_id IS NOT NULL;

CREATE TABLE subject_memberships (
  subject_id uuid NOT NULL REFERENCES trading_subjects(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'provider_manager', 'provider_operator', 'viewer')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_id, user_id)
);
CREATE INDEX subject_memberships_user_active ON subject_memberships(user_id, subject_id) WHERE status = 'active';

CREATE TABLE subject_selections (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  subject_id uuid NOT NULL,
  selected_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  FOREIGN KEY (subject_id, user_id) REFERENCES subject_memberships(subject_id, user_id)
);

-- Existing supplier records become personal trading subjects. New accounts receive
-- their personal subject lazily on the first subject/bootstrap request.
INSERT INTO trading_subjects(id, kind, display_name, owner_user_id)
SELECT s.id, 'personal', u.display_name, s.user_id
FROM supplier_profiles s JOIN users u ON u.id = s.user_id;

INSERT INTO subject_memberships(subject_id, user_id, role, status)
SELECT id, user_id, 'owner', 'active' FROM supplier_profiles;

INSERT INTO subject_selections(user_id, subject_id)
SELECT user_id, id FROM supplier_profiles;

ALTER TABLE supplier_profiles ADD COLUMN subject_id uuid REFERENCES trading_subjects(id);
UPDATE supplier_profiles SET subject_id = id;
ALTER TABLE supplier_profiles ALTER COLUMN subject_id SET NOT NULL;
ALTER TABLE supplier_profiles DROP CONSTRAINT supplier_profiles_user_id_key;
ALTER TABLE supplier_profiles RENAME COLUMN user_id TO created_by_user_id;
ALTER TABLE supplier_profiles ADD CONSTRAINT supplier_profiles_subject_unique UNIQUE (subject_id);
CREATE INDEX supplier_profiles_creator ON supplier_profiles(created_by_user_id);

CREATE TRIGGER trading_subjects_updated_at
  BEFORE UPDATE ON trading_subjects FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER subject_memberships_updated_at
  BEFORE UPDATE ON subject_memberships FOR EACH ROW EXECUTE FUNCTION set_updated_at();
