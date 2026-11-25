-- This preference is an authorization for one login and family, never a browser
-- identifier or a saved credential. Session expiry/revocation is checked by the
-- normal identity boundary before every read and business transaction.
CREATE TABLE saas_parent_devices (
  session_hash TEXT NOT NULL REFERENCES saas_sessions(token_hash) ON DELETE CASCADE,
  family_id TEXT COLLATE NOCASE NOT NULL,
  user_id TEXT COLLATE NOCASE NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_hash, family_id, user_id),
  FOREIGN KEY (family_id, user_id) REFERENCES saas_memberships(family_id, user_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX saas_parent_devices_family_idx ON saas_parent_devices(family_id);
CREATE INDEX saas_parent_devices_user_idx ON saas_parent_devices(user_id);
INSERT INTO saas_schema_migrations(version) VALUES (4);
