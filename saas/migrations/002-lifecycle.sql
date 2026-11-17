-- Lifecycle and maintenance lookup indexes for the SQLite authority.
-- Foreign keys and ownership are established in migration 1, so a new file
-- never passes through a weaker lifecycle schema between application starts.
CREATE INDEX saas_invitations_inviter_idx ON saas_invitations(invited_by);
CREATE INDEX saas_invitations_email_idx ON saas_invitations(email);
CREATE INDEX saas_sessions_expiry_idx ON saas_sessions(expires_at);
CREATE INDEX saas_email_tokens_expiry_idx ON saas_email_tokens(expires_at);
CREATE INDEX saas_invitations_expiry_idx ON saas_invitations(expires_at);
CREATE INDEX saas_challenges_expiry_idx ON saas_parent_challenges(expires_at);
CREATE INDEX saas_grants_expiry_idx ON saas_parent_grants(expires_at);
CREATE INDEX saas_rate_limits_expiry_idx ON saas_rate_limits(expires_at);
CREATE INDEX saas_leases_expiry_idx ON saas_assistant_leases(expires_at);
INSERT INTO saas_schema_migrations(version) VALUES (2);
