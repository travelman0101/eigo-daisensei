CREATE TABLE users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  picture TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- shared cache of fetched transcripts (dedupes provider calls); purged after expires_at
CREATE TABLE transcripts (
  video_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  hash TEXT NOT NULL,
  source TEXT NOT NULL,
  segments TEXT NOT NULL,
  available_langs TEXT NOT NULL DEFAULT '[]',
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (video_id, lang)
);

-- remembers "this video has no transcript" for a short time so retries do not spend credits
CREATE TABLE transcript_misses (
  video_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- in-flight provider jobs, so a double click or retry reuses the same job
CREATE TABLE transcript_jobs (
  video_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- results of AI calls keyed by a hash of (kind, version, model, input)
CREATE TABLE ai_cache (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- every provider / AI call, cached or not, for the usage screen and daily limits
CREATE TABLE usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  ip_hash TEXT,
  kind TEXT NOT NULL,
  model TEXT,
  units REAL NOT NULL DEFAULT 0,
  neurons REAL NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0,
  cached INTEGER NOT NULL DEFAULT 0,
  day TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX usage_user_day ON usage_log(user_id, day, kind);
CREATE INDEX usage_ip_day ON usage_log(ip_hash, day, kind);

-- per-user backup of on-device data
CREATE TABLE backup_items (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  json TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, kind, id)
);

-- an AI call in progress, so a double click or parallel retry waits for it instead of calling again
CREATE TABLE ai_inflight (
  key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
