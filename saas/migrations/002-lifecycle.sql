-- v0.14 lifecycle and temporary-record maintenance. No legacy data import.
ALTER TABLE saas_invitations ALTER COLUMN invited_by DROP NOT NULL;
ALTER TABLE saas_invitations DROP CONSTRAINT IF EXISTS saas_invitations_invited_by_fkey;
ALTER TABLE saas_invitations ADD CONSTRAINT saas_invitations_invited_by_fkey
  FOREIGN KEY (invited_by) REFERENCES saas_users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS saas_invitations_inviter_idx ON saas_invitations(invited_by);
CREATE INDEX IF NOT EXISTS saas_invitations_email_idx ON saas_invitations(email);
-- A revoked member/session may still have a provider request in flight. Keep
-- its short-lived family lease until finally/TTL so revocation cannot bypass
-- the cross-instance max-two cap. Erase deleted account/session identifiers.
ALTER TABLE saas_assistant_leases DROP CONSTRAINT IF EXISTS saas_assistant_leases_family_id_user_id_fkey;
ALTER TABLE saas_assistant_leases DROP CONSTRAINT IF EXISTS saas_assistant_leases_session_hash_fkey;
ALTER TABLE saas_assistant_leases ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE saas_assistant_leases ALTER COLUMN session_hash DROP NOT NULL;
ALTER TABLE saas_assistant_leases ADD CONSTRAINT saas_assistant_leases_family_id_fkey
  FOREIGN KEY (family_id) REFERENCES saas_families(id) ON DELETE CASCADE;
ALTER TABLE saas_assistant_leases ADD CONSTRAINT saas_assistant_leases_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES saas_users(id) ON DELETE SET NULL;
ALTER TABLE saas_assistant_leases ADD CONSTRAINT saas_assistant_leases_session_hash_fkey
  FOREIGN KEY (session_hash) REFERENCES saas_sessions(token_hash) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS saas_sessions_expiry_idx ON saas_sessions(expires_at);
CREATE INDEX IF NOT EXISTS saas_email_tokens_expiry_idx ON saas_email_tokens(expires_at);
CREATE INDEX IF NOT EXISTS saas_invitations_expiry_idx ON saas_invitations(expires_at);
CREATE INDEX IF NOT EXISTS saas_challenges_expiry_idx ON saas_parent_challenges(expires_at);
CREATE INDEX IF NOT EXISTS saas_grants_expiry_idx ON saas_parent_grants(expires_at);
CREATE INDEX IF NOT EXISTS saas_rate_limits_expiry_idx ON saas_rate_limits(expires_at);
CREATE INDEX IF NOT EXISTS saas_leases_expiry_idx ON saas_assistant_leases(expires_at);

-- Ownership can be absent between the two transfer UPDATEs, never at COMMIT.
-- A deleted family is absent here and its cascading membership DELETE is valid.
CREATE OR REPLACE FUNCTION saas_require_family_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE family_key uuid;
BEGIN
  IF TG_TABLE_NAME = 'saas_families' THEN
    family_key := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    family_key := OLD.family_id;
  ELSE
    family_key := NEW.family_id;
  END IF;
  IF EXISTS (SELECT 1 FROM saas_families WHERE id=family_key) AND
      (SELECT count(*) FROM saas_memberships WHERE family_id=family_key AND role='owner') <> 1 THEN
    RAISE EXCEPTION 'A family must retain exactly one owner' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME = 'saas_memberships' THEN
    IF TG_OP = 'UPDATE' THEN
      IF OLD.family_id <> NEW.family_id AND EXISTS (SELECT 1 FROM saas_families WHERE id=OLD.family_id) AND
          (SELECT count(*) FROM saas_memberships WHERE family_id=OLD.family_id AND role='owner') <> 1 THEN
        RAISE EXCEPTION 'A family must retain exactly one owner' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS saas_family_owner_membership ON saas_memberships;
CREATE CONSTRAINT TRIGGER saas_family_owner_membership AFTER INSERT OR UPDATE OR DELETE ON saas_memberships
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION saas_require_family_owner();
DROP TRIGGER IF EXISTS saas_family_owner_create ON saas_families;
CREATE CONSTRAINT TRIGGER saas_family_owner_create AFTER INSERT ON saas_families
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION saas_require_family_owner();
INSERT INTO saas_schema_migrations(version) VALUES (2) ON CONFLICT DO NOTHING;
