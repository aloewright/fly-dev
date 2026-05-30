#!/bin/bash
set -uo pipefail
cd /Users/aloe/Development/fly-dev
CF_EMAIL=$(doppler secrets get CLOUDFLARE_EMAIL --plain 2>/dev/null)
CF_KEY=$(doppler secrets get CLOUDFLARE_API_KEY --plain 2>/dev/null)
ACCT=$(curl -s "https://api.cloudflare.com/client/v4/accounts" -H "X-Auth-Email: $CF_EMAIL" -H "X-Auth-Key: $CF_KEY" | jq -r '.result[0].id')
DBID="3f03fde5-d0ba-4f35-940e-318567b45cab"
q() { curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCT/d1/database/$DBID/query" \
  -H "X-Auth-Email: $CF_EMAIL" -H "X-Auth-Key: $CF_KEY" -H "Content-Type: application/json" --data "{\"sql\":\"$1\"}"; }

echo "===== app_users matching probe%@example.com (preview before delete) ====="
q "SELECT id, fly_user_slug, email, auth_source FROM app_users WHERE email LIKE 'probe%@example.com'" \
  | jq -c '.result[0].results // .errors'

echo "===== related rows that reference those users (FK safety check) ====="
for t in account_connections runs artifacts agent_memories usage_events approvals oauth_state; do
  exists=$(q "SELECT name FROM sqlite_master WHERE type='table' AND name='$t'" | jq -r '.result[0].results | length')
  if [ "$exists" = "1" ]; then
    cnt=$(q "SELECT COUNT(*) AS n FROM $t WHERE user_id IN (SELECT id FROM app_users WHERE email LIKE 'probe%@example.com')" | jq -r '.result[0].results[0].n // "err"')
    echo "  $t: $cnt rows referencing probe users"
  fi
done
echo "DONE_PREVIEW"
