-- AGPL-3.0-or-later
-- Pipeline scaffold: PR/Linear write-back fields on runs + webhook dedup.

ALTER TABLE runs ADD COLUMN pr_url TEXT;
ALTER TABLE runs ADD COLUMN commit_sha TEXT;
ALTER TABLE runs ADD COLUMN branch_name TEXT;
ALTER TABLE runs ADD COLUMN linear_issue_id TEXT;
ALTER TABLE runs ADD COLUMN linear_team_id TEXT;

-- Deduplicate webhook deliveries (GitHub/Linear retry on non-2xx). NULL event_id
-- is excluded so deliveries without a delivery id always insert.
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_events_provider_event
  ON webhook_events(provider, event_id)
  WHERE event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
