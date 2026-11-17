-- v0.13 SaaS authority. This migration never reads the legacy data directory.
CREATE TABLE IF NOT EXISTS saas_schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS saas_users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) <= 254),
  password_hash jsonb NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS saas_sessions (
  token_hash text PRIMARY KEY CHECK (length(token_hash) = 64),
  user_id uuid NOT NULL REFERENCES saas_users(id) ON DELETE CASCADE,
  csrf_hash text NOT NULL CHECK (length(csrf_hash) = 64),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS saas_sessions_user_idx ON saas_sessions(user_id);
CREATE TABLE IF NOT EXISTS saas_email_tokens (
  token_hash text PRIMARY KEY CHECK (length(token_hash) = 64),
  user_id uuid NOT NULL REFERENCES saas_users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify', 'reset')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS saas_email_tokens_user_idx ON saas_email_tokens(user_id, purpose);
CREATE TABLE IF NOT EXISTS saas_families (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  parent jsonb NOT NULL DEFAULT '{"configured":false,"method":null}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS saas_memberships (
  family_id uuid NOT NULL REFERENCES saas_families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES saas_users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'parent')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (family_id, user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS saas_one_owner_idx ON saas_memberships(family_id) WHERE role = 'owner';
CREATE INDEX IF NOT EXISTS saas_memberships_user_idx ON saas_memberships(user_id);
CREATE TABLE IF NOT EXISTS saas_family_requests (
  user_id uuid NOT NULL REFERENCES saas_users(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  digest text NOT NULL,
  family_id uuid NOT NULL REFERENCES saas_families(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, request_id)
);
CREATE TABLE IF NOT EXISTS saas_invitations (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES saas_families(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(email)),
  role text NOT NULL DEFAULT 'parent' CHECK (role = 'parent'),
  token_hash text NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  invited_by uuid NOT NULL REFERENCES saas_users(id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS saas_invitations_family_idx ON saas_invitations(family_id);
CREATE TABLE IF NOT EXISTS saas_family_imports (
  family_id uuid PRIMARY KEY REFERENCES saas_families(id) ON DELETE CASCADE,
  source_sha256 text NOT NULL CHECK (length(source_sha256) = 64),
  source_revision bigint NOT NULL CHECK (source_revision >= 1),
  imported_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS saas_action_receipts (
  family_id uuid NOT NULL REFERENCES saas_families(id) ON DELETE CASCADE,
  action_id text NOT NULL,
  receipt jsonb NOT NULL,
  revision bigint NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (family_id, action_id)
);
CREATE TABLE IF NOT EXISTS saas_parent_challenges (
  token_hash text PRIMARY KEY,
  family_id uuid NOT NULL,
  user_id uuid NOT NULL,
  session_hash text NOT NULL REFERENCES saas_sessions(token_hash) ON DELETE CASCADE,
  revision bigint NOT NULL,
  action_receipt jsonb NOT NULL,
  method text NOT NULL CHECK (method IN ('pin', 'math')),
  answer_hash text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (family_id, user_id) REFERENCES saas_memberships(family_id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS saas_challenges_family_idx ON saas_parent_challenges(family_id);
CREATE TABLE IF NOT EXISTS saas_parent_grants (
  token_hash text PRIMARY KEY,
  family_id uuid NOT NULL,
  user_id uuid NOT NULL,
  session_hash text NOT NULL REFERENCES saas_sessions(token_hash) ON DELETE CASCADE,
  revision bigint NOT NULL,
  action_receipt jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (family_id, user_id) REFERENCES saas_memberships(family_id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS saas_grants_family_idx ON saas_parent_grants(family_id);
CREATE TABLE IF NOT EXISTS saas_assistant_leases (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL,
  user_id uuid NOT NULL,
  session_hash text NOT NULL REFERENCES saas_sessions(token_hash) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (family_id, user_id) REFERENCES saas_memberships(family_id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS saas_assistant_leases_family_idx ON saas_assistant_leases(family_id, expires_at);
CREATE TABLE IF NOT EXISTS saas_rate_limits (
  scope text PRIMARY KEY,
  count integer NOT NULL CHECK (count >= 0),
  expires_at timestamptz NOT NULL
);
INSERT INTO saas_schema_migrations(version) VALUES (1) ON CONFLICT DO NOTHING;
