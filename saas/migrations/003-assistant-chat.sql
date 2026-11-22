-- Conversations belong to a membership, not to a browser session. Removing
-- and later re-inviting a parent must never restore that parent's old context.
CREATE TABLE saas_assistant_chats (
  family_id TEXT COLLATE NOCASE NOT NULL,
  user_id TEXT COLLATE NOCASE NOT NULL,
  generation TEXT NOT NULL CHECK (length(generation)=43),
  sequence INTEGER NOT NULL DEFAULT 0 CHECK (sequence BETWEEN 0 AND 9007199254740991),
  draft TEXT CHECK (draft IS NULL OR json_valid(draft)),
  context_result TEXT CHECK (context_result IS NULL OR json_valid(context_result)),
  pending_turn_id TEXT,
  pending_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (family_id,user_id),
  FOREIGN KEY (family_id,user_id) REFERENCES saas_memberships(family_id,user_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE saas_assistant_turns (
  family_id TEXT COLLATE NOCASE NOT NULL,
  user_id TEXT COLLATE NOCASE NOT NULL,
  generation TEXT NOT NULL CHECK (length(generation)=43),
  turn_id TEXT COLLATE NOCASE NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  input_digest TEXT NOT NULL CHECK (length(input_digest)=64),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 1200),
  result TEXT CHECK (result IS NULL OR json_valid(result)),
  actions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(actions) AND json_type(actions)='array'),
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  family_day TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (family_id,user_id,generation,turn_id),
  UNIQUE (family_id,user_id,generation,sequence),
  FOREIGN KEY (family_id,user_id) REFERENCES saas_assistant_chats(family_id,user_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX saas_assistant_turns_recent_idx ON saas_assistant_turns(family_id,user_id,generation,sequence DESC);
INSERT INTO saas_schema_migrations(version) VALUES (3);
