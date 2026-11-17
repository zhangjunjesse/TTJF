-- SQLite authority. This creates a new database; it never reads PostgreSQL or
-- the legacy business data directory. JSON and timestamps are stored as text.
CREATE TABLE IF NOT EXISTS saas_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE TABLE saas_users (
  id TEXT COLLATE NOCASE PRIMARY KEY NOT NULL CHECK (length(id)=36 AND length(replace(id,'-',''))=32 AND id GLOB '????????-????-????-????-????????????' AND replace(id,'-','') NOT GLOB '*[^a-fA-F0-9]*'),
  email TEXT NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) <= 254),
  password_hash TEXT NOT NULL CHECK (json_valid(password_hash)),
  verified_at TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE saas_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL CHECK (length(token_hash) = 64),
  user_id TEXT COLLATE NOCASE NOT NULL REFERENCES saas_users(id) ON DELETE CASCADE,
  csrf_hash TEXT NOT NULL CHECK (length(csrf_hash) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;
CREATE INDEX saas_sessions_user_idx ON saas_sessions(user_id);
CREATE TABLE saas_email_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL CHECK (length(token_hash) = 64),
  user_id TEXT COLLATE NOCASE NOT NULL REFERENCES saas_users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
) STRICT;
CREATE INDEX saas_email_tokens_user_idx ON saas_email_tokens(user_id, purpose);
CREATE TABLE saas_families (
  id TEXT COLLATE NOCASE PRIMARY KEY NOT NULL CHECK (length(id)=36 AND length(replace(id,'-',''))=32 AND id GLOB '????????-????-????-????-????????????' AND replace(id,'-','') NOT GLOB '*[^a-fA-F0-9]*'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL CHECK (json_valid(state) AND json_type(state) = 'object'),
  parent TEXT NOT NULL DEFAULT '{"configured":false,"method":null}' CHECK (json_valid(parent)),
  owner_user_id TEXT COLLATE NOCASE NOT NULL,
  owner_role TEXT NOT NULL DEFAULT 'owner' CHECK (owner_role = 'owner'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- The pointer must name this family's owner at COMMIT. The deferred FK
  -- permits family creation and the temporary owner gap during a transfer.
  FOREIGN KEY (id, owner_user_id, owner_role) REFERENCES saas_memberships(family_id, user_id, role)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE saas_memberships (
  family_id TEXT COLLATE NOCASE NOT NULL REFERENCES saas_families(id) ON DELETE CASCADE,
  user_id TEXT COLLATE NOCASE NOT NULL REFERENCES saas_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'parent')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (family_id, user_id),
  UNIQUE (family_id, user_id, role)
) STRICT;
CREATE UNIQUE INDEX saas_one_owner_idx ON saas_memberships(family_id) WHERE role = 'owner';
CREATE INDEX saas_memberships_user_idx ON saas_memberships(user_id);
CREATE TABLE saas_family_requests (
  user_id TEXT COLLATE NOCASE NOT NULL REFERENCES saas_users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  family_id TEXT COLLATE NOCASE NOT NULL REFERENCES saas_families(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, request_id)
) STRICT;
CREATE TABLE saas_invitations (
  id TEXT COLLATE NOCASE PRIMARY KEY NOT NULL CHECK (length(id)=36 AND length(replace(id,'-',''))=32 AND id GLOB '????????-????-????-????-????????????' AND replace(id,'-','') NOT GLOB '*[^a-fA-F0-9]*'),
  family_id TEXT COLLATE NOCASE NOT NULL REFERENCES saas_families(id) ON DELETE CASCADE,
  email TEXT NOT NULL CHECK (email = lower(email)),
  role TEXT NOT NULL DEFAULT 'parent' CHECK (role = 'parent'),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  invited_by TEXT COLLATE NOCASE REFERENCES saas_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT
) STRICT;
CREATE INDEX saas_invitations_family_idx ON saas_invitations(family_id);
CREATE TABLE saas_family_imports (
  family_id TEXT COLLATE NOCASE PRIMARY KEY NOT NULL REFERENCES saas_families(id) ON DELETE CASCADE,
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  imported_at TEXT NOT NULL
) STRICT;
CREATE TABLE saas_action_receipts (
  family_id TEXT COLLATE NOCASE NOT NULL REFERENCES saas_families(id) ON DELETE CASCADE,
  action_id TEXT NOT NULL,
  receipt TEXT NOT NULL CHECK (json_valid(receipt)),
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (family_id, action_id)
) STRICT;
CREATE TABLE saas_parent_challenges (
  token_hash TEXT PRIMARY KEY NOT NULL,
  family_id TEXT COLLATE NOCASE NOT NULL,
  user_id TEXT COLLATE NOCASE NOT NULL,
  session_hash TEXT NOT NULL REFERENCES saas_sessions(token_hash) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  action_receipt TEXT NOT NULL CHECK (json_valid(action_receipt)),
  method TEXT NOT NULL CHECK (method IN ('pin', 'math')),
  answer_hash TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  expires_at TEXT NOT NULL,
  FOREIGN KEY (family_id, user_id) REFERENCES saas_memberships(family_id, user_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX saas_challenges_family_idx ON saas_parent_challenges(family_id);
CREATE TABLE saas_parent_grants (
  token_hash TEXT PRIMARY KEY NOT NULL,
  family_id TEXT COLLATE NOCASE NOT NULL,
  user_id TEXT COLLATE NOCASE NOT NULL,
  session_hash TEXT NOT NULL REFERENCES saas_sessions(token_hash) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  action_receipt TEXT NOT NULL CHECK (json_valid(action_receipt)),
  expires_at TEXT NOT NULL,
  FOREIGN KEY (family_id, user_id) REFERENCES saas_memberships(family_id, user_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX saas_grants_family_idx ON saas_parent_grants(family_id);
-- Provider work can outlive revocation. Retain the family lease until its
-- finally/TTL, while erasing deleted account/session identifiers.
CREATE TABLE saas_assistant_leases (
  id TEXT COLLATE NOCASE PRIMARY KEY NOT NULL CHECK (length(id)=36 AND length(replace(id,'-',''))=32 AND id GLOB '????????-????-????-????-????????????' AND replace(id,'-','') NOT GLOB '*[^a-fA-F0-9]*'),
  family_id TEXT COLLATE NOCASE NOT NULL REFERENCES saas_families(id) ON DELETE CASCADE,
  user_id TEXT COLLATE NOCASE REFERENCES saas_users(id) ON DELETE SET NULL,
  session_hash TEXT REFERENCES saas_sessions(token_hash) ON DELETE SET NULL,
  expires_at TEXT NOT NULL
) STRICT;
CREATE INDEX saas_assistant_leases_family_idx ON saas_assistant_leases(family_id, expires_at);
CREATE TABLE saas_rate_limits (
  scope TEXT PRIMARY KEY NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  expires_at TEXT NOT NULL
) STRICT;
INSERT INTO saas_schema_migrations(version) VALUES (1);
