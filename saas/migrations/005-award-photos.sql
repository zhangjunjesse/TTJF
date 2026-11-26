-- Image bytes stay outside the family JSON aggregate. An upload is private to
-- its uploader until the award and its permanent receipt commit together.
CREATE TABLE saas_award_photos (
  family_id TEXT COLLATE NOCASE NOT NULL REFERENCES saas_families(id) ON DELETE CASCADE,
  id TEXT COLLATE NOCASE NOT NULL CHECK (length(id)=36 AND length(replace(id,'-',''))=32 AND id GLOB '????????-????-????-????-????????????' AND replace(id,'-','') NOT GLOB '*[^a-fA-F0-9]*'),
  uploaded_by TEXT COLLATE NOCASE REFERENCES saas_users(id) ON DELETE SET NULL,
  data BLOB NOT NULL CHECK (length(data) BETWEEN 16 AND 786432),
  action_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  committed_at TEXT,
  PRIMARY KEY (family_id,id),
  CHECK ((action_id IS NULL AND committed_at IS NULL) OR (action_id IS NOT NULL AND committed_at IS NOT NULL)),
  FOREIGN KEY (family_id,action_id) REFERENCES saas_action_receipts(family_id,action_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX saas_award_photos_pending_idx ON saas_award_photos(family_id,uploaded_by,expires_at) WHERE action_id IS NULL;
CREATE INDEX saas_award_photos_expiry_idx ON saas_award_photos(expires_at) WHERE action_id IS NULL;
-- A canceled chooser can finish uploading after cancellation reaches the
-- server. Keep only its scoped identity until the upload window expires.
CREATE TABLE saas_award_photo_discards (
  family_id TEXT COLLATE NOCASE NOT NULL REFERENCES saas_families(id) ON DELETE CASCADE,
  id TEXT COLLATE NOCASE NOT NULL CHECK (length(id)=36 AND length(replace(id,'-',''))=32 AND id GLOB '????????-????-????-????-????????????' AND replace(id,'-','') NOT GLOB '*[^a-fA-F0-9]*'),
  uploaded_by TEXT COLLATE NOCASE NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (family_id,id,uploaded_by),
  FOREIGN KEY (family_id,uploaded_by) REFERENCES saas_memberships(family_id,user_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX saas_award_photo_discards_expiry_idx ON saas_award_photo_discards(expires_at);
INSERT INTO saas_schema_migrations(version) VALUES (5);
