-- AGPL-3.0-or-later
-- GitHub repositories synced from a connected GitHub account, mirroring how
-- linear_projects holds the synced Linear projects. Keyed on the numeric GitHub
-- repo id so renames/transfers update in place.

CREATE TABLE IF NOT EXISTS github_repos (
  id TEXT PRIMARY KEY,                     -- "gh_<numeric repo id>"
  user_id TEXT NOT NULL,                   -- owner of the connection that synced it
  github_id INTEGER NOT NULL,              -- numeric repo id from GitHub
  owner TEXT NOT NULL,
  name TEXT NOT NULL,                      -- repo name (without owner)
  full_name TEXT NOT NULL,                 -- "owner/name"
  url TEXT NOT NULL,
  description TEXT,
  private INTEGER NOT NULL DEFAULT 0,
  fork INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  default_branch TEXT,
  open_issues INTEGER NOT NULL DEFAULT 0,
  stars INTEGER NOT NULL DEFAULT 0,
  language TEXT,
  pushed_at TEXT,
  updated_at TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, github_id)
);

CREATE INDEX IF NOT EXISTS idx_github_repos_user ON github_repos(user_id);
CREATE INDEX IF NOT EXISTS idx_github_repos_pushed ON github_repos(user_id, pushed_at DESC);
