/** Each migration and its user_version advance commit together. Never rewrite a shipped migration. */
export const RECORD_MIGRATIONS = [String.raw`
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  owner_device_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
  native_id TEXT NOT NULL,
  title TEXT, cwd TEXT, parent_native_id TEXT, fork_native_id TEXT,
  UNIQUE (owner_device_id, provider, native_id)
);
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  path TEXT NOT NULL, device TEXT NOT NULL, inode TEXT NOT NULL,
  size INTEGER NOT NULL, modified_ms REAL NOT NULL,
  generation INTEGER NOT NULL, committed_offset INTEGER NOT NULL,
  prefix_hash TEXT NOT NULL, prefix_length INTEGER NOT NULL,
  checkpoint_hash TEXT NOT NULL, checkpoint_length INTEGER NOT NULL,
  parser_version INTEGER NOT NULL, state_json TEXT NOT NULL,
  malformed_lines INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  native_id TEXT, parent_id TEXT,
  boundary TEXT NOT NULL CHECK (boundary IN ('native', 'inferred')),
  started_at REAL, ended_at REAL, status TEXT, context_json TEXT
);
CREATE TABLE items (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT, native_id TEXT, parent_id TEXT,
  kind TEXT NOT NULL, role TEXT, text TEXT, content_json TEXT,
  at REAL, order_key TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX items_session_native ON items(session_id, native_id);
CREATE INDEX items_session_order ON items(session_id, order_key, id);
CREATE TABLE item_sources (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id),
  source_path TEXT NOT NULL, source_device TEXT NOT NULL, source_inode TEXT NOT NULL,
  generation INTEGER NOT NULL, byte_offset INTEGER NOT NULL,
  byte_length INTEGER NOT NULL, selector INTEGER NOT NULL,
  PRIMARY KEY (item_id, source_id, generation, byte_offset, selector)
);
CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  native_id TEXT NOT NULL,
  call_item_id TEXT, result_item_id TEXT,
  name TEXT, arguments_json TEXT, result_json TEXT, status TEXT, files_json TEXT,
  UNIQUE (session_id, native_id)
);
CREATE TABLE responses (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT, native_id TEXT,
  provider TEXT, model TEXT, effort TEXT,
  measurement TEXT NOT NULL CHECK (measurement IN ('response', 'cumulative', 'context')),
  input_tokens INTEGER, output_tokens INTEGER, cached_input_tokens INTEGER,
  cache_write_tokens INTEGER, reasoning_tokens INTEGER,
  context_tokens INTEGER, context_window INTEGER, at REAL,
  UNIQUE (session_id, measurement, native_id)
);
CREATE INDEX responses_turn ON responses(session_id, turn_id);
-- Journal references deliberately have no foreign keys into the rebuildable index.
CREATE TABLE receipts (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, action_id TEXT NOT NULL,
  attempt_id TEXT, turn_id TEXT, item_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('delivery', 'review', 'speech')),
  state TEXT NOT NULL, observed_at REAL NOT NULL, details_json TEXT
);
CREATE INDEX receipts_action ON receipts(action_id, observed_at, id);
CREATE TRIGGER receipts_immutable_update BEFORE UPDATE ON receipts
BEGIN SELECT RAISE(ABORT, 'receipts are immutable'); END;
CREATE TRIGGER receipts_immutable_delete BEFORE DELETE ON receipts
BEGIN SELECT RAISE(ABORT, 'receipts are immutable'); END;
`, String.raw`
ALTER TABLE sources ADD COLUMN coverage_status TEXT NOT NULL DEFAULT 'queued';
ALTER TABLE sources ADD COLUMN coverage_error TEXT;
ALTER TABLE sources ADD COLUMN coverage_updated_at REAL NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN replay_required INTEGER NOT NULL DEFAULT 0;
CREATE INDEX sources_session ON sources(session_id, id);
`];
