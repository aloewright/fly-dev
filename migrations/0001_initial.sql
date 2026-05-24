-- AGPL-3.0-or-later

CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY,
  email TEXT,
  name TEXT,
  avatar_url TEXT,
  fly_user_slug TEXT NOT NULL UNIQUE,
  auth_source TEXT NOT NULL DEFAULT 'fly',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS account_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_account_id TEXT,
  account_name TEXT,
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  scopes TEXT,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'needs_connection',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, provider)
);

CREATE TABLE IF NOT EXISTS linear_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  url TEXT,
  summary TEXT,
  description TEXT,
  team_key TEXT,
  lead_name TEXT,
  repo_mapping_status TEXT NOT NULL DEFAULT 'unmapped',
  repo_confidence REAL NOT NULL DEFAULT 0,
  updated_at TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS repository_mappings (
  id TEXT PRIMARY KEY,
  linear_project_id TEXT NOT NULL REFERENCES linear_projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'github',
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  url TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(linear_project_id, provider, owner, repo)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id),
  project_id TEXT REFERENCES linear_projects(id),
  repo_mapping_id TEXT REFERENCES repository_mappings(id),
  objective TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  autonomy_mode TEXT NOT NULL DEFAULT 'manual_approval',
  agent_provider TEXT NOT NULL DEFAULT 'codex',
  sandbox_id TEXT,
  approval_required INTEGER NOT NULL DEFAULT 1,
  approved_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  last_error TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES app_users(id),
  project_id TEXT REFERENCES linear_projects(id),
  run_id TEXT REFERENCES runs(id),
  category TEXT NOT NULL,
  provider TEXT,
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT 'event',
  cost_micros INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  r2_key TEXT,
  url TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL UNIQUE,
  repo TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES app_users(id),
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_at TEXT,
  reason TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_id TEXT,
  event_type TEXT,
  signature_valid INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  processed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id),
  project_id TEXT REFERENCES linear_projects(id),
  session_id TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'session',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_account_connections_user ON account_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_runs_user_status ON runs(user_id, status);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
CREATE INDEX IF NOT EXISTS idx_run_events_run_created ON run_events(run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_user_created ON usage_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_repository_mappings_project ON repository_mappings(linear_project_id);
CREATE INDEX IF NOT EXISTS idx_agent_memories_session ON agent_memories(user_id, session_id);

INSERT OR IGNORE INTO templates (id, kind, repo, description, metadata_json)
VALUES
  ('template_cloudflare_fullstack', 'cloudflare-fullstack', 'aloewright/aloe-template-cloudflare-fullstack', 'Cloudflare full-stack app template with Vite, Hono, Better Auth, Drizzle, and D1.', '{"runtime":"cloudflare","deploy":["workers","pages"]}'),
  ('template_apple_multiplatform', 'apple-multiplatform', 'aloewright/warp-template-apple-multiplatform', 'SwiftUI multiplatform template for iOS, iPadOS, macOS, and watchOS.', '{"runtime":"apple","build":["github-actions-macos","local-macos-runner"]}');
