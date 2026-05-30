/* AGPL-3.0-or-later */
import type { CurrentUser, Env } from "../env";
import { decryptText, encryptText, hmacHex, timingSafeEqual } from "./crypto";
import { all, first, id, runSql } from "./data";
import {
  extractGitHubReposFromText,
  repoMappingStatus,
  type RepoCandidate,
} from "./repo-mapping";

export type OAuthProvider = "github" | "linear";

export type OAuthConnectResult =
  | { setupRequired: true; provider: OAuthProvider; missing: string[] }
  | { setupRequired: false; provider: OAuthProvider; url: string };

export async function createOAuthConnectUrl(
  provider: OAuthProvider,
  request: Request,
  env: Env,
  user: CurrentUser,
): Promise<OAuthConnectResult> {
  const appUrl = new URL(env.APP_URL || request.url);
  const redirectUri = `${appUrl.origin}/api/integrations/${provider}/callback`;
  const state = await createOAuthState(env, provider, user.id, redirectUri);

  if (provider === "github") {
    const missing = missingVars(env, ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]);
    if (missing.length > 0) {
      return { setupRequired: true, provider, missing };
    }

    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", env.GITHUB_CLIENT_ID!);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", "repo read:org read:user user:email workflow");
    url.searchParams.set("state", state);
    return { setupRequired: false, provider, url: url.toString() };
  }

  const missing = missingVars(env, ["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET"]);
  if (missing.length > 0) {
    return { setupRequired: true, provider, missing };
  }

  const url = new URL("https://linear.app/oauth/authorize");
  url.searchParams.set("client_id", env.LINEAR_CLIENT_ID!);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  // Linear expects a COMMA-separated scope list, unlike GitHub's space-separated
  // form. Space-separated values are read as a single invalid scope. See
  // https://linear.app/developers/oauth-2-0-authentication
  url.searchParams.set("scope", "read,write,issues:create");
  url.searchParams.set("state", state);
  return { setupRequired: false, provider, url: url.toString() };
}

export async function handleOAuthCallback(
  provider: OAuthProvider,
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return Response.json({ error: "Missing OAuth code or state" }, { status: 400 });
  }

  const stateRecord = await consumeOAuthState(env, provider, state);
  if (!stateRecord) {
    return Response.json({ error: "Invalid or expired OAuth state" }, { status: 400 });
  }

  // Fail fast rather than silently storing NULL tokens when the key is missing.
  // See SANDBOX_REVIEW.md A6.
  if (!env.TOKEN_ENCRYPTION_KEY) {
    return Response.json(
      { error: "TOKEN_ENCRYPTION_KEY is not configured; cannot store OAuth tokens" },
      { status: 500 },
    );
  }

  const redirectUri = stateRecord.redirectUri;
  const token = provider === "github"
    ? await exchangeGitHubCode(env, code, redirectUri)
    : await exchangeLinearCode(env, code, redirectUri);

  const encryptedAccessToken = await encryptText(token.accessToken, env.TOKEN_ENCRYPTION_KEY);
  const encryptedRefreshToken = await encryptText(token.refreshToken ?? "", env.TOKEN_ENCRYPTION_KEY);

  await runSql(
    env,
    `INSERT INTO account_connections
       (id, user_id, provider, external_account_id, account_name, access_token_encrypted, refresh_token_encrypted, scopes, expires_at, status, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?)
     ON CONFLICT(user_id, provider) DO UPDATE SET
       external_account_id = excluded.external_account_id,
       account_name = excluded.account_name,
       access_token_encrypted = excluded.access_token_encrypted,
       refresh_token_encrypted = excluded.refresh_token_encrypted,
       scopes = excluded.scopes,
       expires_at = excluded.expires_at,
       status = 'connected',
       metadata_json = excluded.metadata_json,
       updated_at = CURRENT_TIMESTAMP`,
    [
      id("conn"),
      stateRecord.userId,
      provider,
      token.externalAccountId,
      token.accountName,
      encryptedAccessToken,
      encryptedRefreshToken,
      token.scopes,
      token.expiresAt,
      JSON.stringify(token.metadata),
    ],
  );

  return Response.redirect(`${env.APP_URL}/?connected=${provider}`, 302);
}

export async function verifyWebhook(
  provider: OAuthProvider,
  request: Request,
  env: Env,
  body: string,
): Promise<boolean> {
  if (provider === "github") {
    const secret = env.GITHUB_WEBHOOK_SECRET;
    const signature = request.headers.get("x-hub-signature-256");
    if (!secret || !signature) return false;
    const expected = `sha256=${await hmacHex(secret, body)}`;
    return timingSafeEqual(signature, expected);
  }

  const secret = env.LINEAR_WEBHOOK_SECRET;
  const signature =
    request.headers.get("linear-signature") ?? request.headers.get("x-linear-signature");
  if (!secret || !signature) return false;
  const expected = await hmacHex(secret, body);
  return timingSafeEqual(signature.replace(/^sha256=/, ""), expected);
}

// Persist a webhook delivery. Uses INSERT OR IGNORE against the
// UNIQUE(provider, event_id) index (migration 0002) so retried deliveries are
// deduplicated. Returns isNew=false when the delivery was a duplicate so the
// caller can skip re-dispatching a run. See SANDBOX_REVIEW.md B4.
export async function storeWebhook(
  env: Env,
  provider: OAuthProvider,
  body: string,
  signatureValid: boolean,
  eventId: string | null,
  eventType: string | null,
): Promise<{ isNew: boolean }> {
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO webhook_events
       (id, provider, event_id, event_type, signature_valid, payload_json, processed_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
  )
    .bind(id("webhook"), provider, eventId, eventType, signatureValid ? 1 : 0, body)
    .run();
  return { isNew: Boolean(result.meta.changes) };
}

export async function syncLinearProjectFromPayload(
  env: Env,
  payload: Record<string, unknown>,
): Promise<{ projectId: string | null; candidates: RepoCandidate[] }> {
  const data = (payload.data ?? payload.project ?? payload) as Record<string, unknown>;
  const projectId = stringValue(data.id);
  const name = stringValue(data.name);
  if (!projectId || !name) {
    return { projectId: null, candidates: [] };
  }

  const description = stringValue(data.description) ?? "";
  const summary = stringValue(data.summary);
  const url = stringValue(data.url);
  const candidates = extractGitHubReposFromText(`${description}\n${summary ?? ""}\n${url ?? ""}`);
  const mapping = repoMappingStatus(candidates);

  await runSql(
    env,
    `INSERT INTO linear_projects
       (id, name, slug, status, url, summary, description, repo_mapping_status, repo_confidence, updated_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       slug = excluded.slug,
       status = excluded.status,
       url = excluded.url,
       summary = excluded.summary,
       description = excluded.description,
       repo_mapping_status = excluded.repo_mapping_status,
       repo_confidence = excluded.repo_confidence,
       updated_at = excluded.updated_at,
       synced_at = CURRENT_TIMESTAMP`,
    [
      projectId,
      name,
      stringValue(data.slug),
      stringValue(data.status) ?? stringValue(data.state) ?? "unknown",
      url,
      summary,
      description,
      mapping.status,
      mapping.best?.confidence ?? 0,
      stringValue(data.updatedAt),
    ],
  );

  if (mapping.best) {
    await upsertRepositoryMapping(env, projectId, mapping.best, mapping.status);
  }

  return { projectId, candidates };
}

export async function upsertRepositoryMapping(
  env: Env,
  projectId: string,
  candidate: RepoCandidate,
  status: "mapped" | "needs_review" | "unmapped" = "mapped",
): Promise<void> {
  await runSql(
    env,
    `INSERT INTO repository_mappings
       (id, linear_project_id, owner, repo, url, confidence, source, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(linear_project_id, provider, owner, repo) DO UPDATE SET
       url = excluded.url,
       confidence = excluded.confidence,
       source = excluded.source,
       status = excluded.status,
       updated_at = CURRENT_TIMESTAMP`,
    [
      id("repo"),
      projectId,
      candidate.owner,
      candidate.repo,
      candidate.url,
      candidate.confidence,
      candidate.source,
      status === "mapped" ? "active" : "needs_review",
    ],
  );
}

async function createOAuthState(
  env: Env,
  provider: OAuthProvider,
  userId: string,
  redirectUri: string,
): Promise<string> {
  const state = id("oauth");
  await env.SESSION_CACHE.put(
    `oauth:${provider}:${state}`,
    JSON.stringify({ userId, redirectUri }),
    { expirationTtl: 600 },
  );
  return state;
}

async function consumeOAuthState(
  env: Env,
  provider: OAuthProvider,
  state: string,
): Promise<{ userId: string; redirectUri: string } | null> {
  const key = `oauth:${provider}:${state}`;
  const raw = await env.SESSION_CACHE.get(key);
  if (!raw) return null;
  await env.SESSION_CACHE.delete(key);
  return JSON.parse(raw) as { userId: string; redirectUri: string };
}

async function exchangeGitHubCode(env: Env, code: string, redirectUri: string) {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const token = (await response.json()) as {
    access_token?: string;
    scope?: string;
    error_description?: string;
  };
  if (!token.access_token) {
    throw new Error(token.error_description ?? "GitHub OAuth exchange failed");
  }

  const user = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${token.access_token}`,
      accept: "application/vnd.github+json",
      "user-agent": "fly-dev",
    },
  }).then((res) => res.json() as Promise<{ id?: number; login?: string; name?: string }>);

  return {
    accessToken: token.access_token,
    refreshToken: null,
    scopes: token.scope ?? "",
    expiresAt: null,
    externalAccountId: user.id ? String(user.id) : null,
    accountName: user.login ?? user.name ?? "GitHub",
    metadata: { login: user.login },
  };
}

async function exchangeLinearCode(env: Env, code: string, redirectUri: string) {
  const response = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.LINEAR_CLIENT_ID ?? "",
      client_secret: env.LINEAR_CLIENT_SECRET ?? "",
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  const token = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!token.access_token) {
    throw new Error(token.error_description ?? "Linear OAuth exchange failed");
  }

  const viewer = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token.access_token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query: "{ viewer { id name email } }" }),
  }).then((res) => res.json() as Promise<{ data?: { viewer?: { id: string; name: string; email: string } } }>);

  const expiresAt = token.expires_in
    ? new Date(Date.now() + token.expires_in * 1000).toISOString()
    : null;

  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    scopes: token.scope ?? "",
    expiresAt,
    externalAccountId: viewer.data?.viewer?.id ?? null,
    accountName: viewer.data?.viewer?.name ?? viewer.data?.viewer?.email ?? "Linear",
    metadata: { email: viewer.data?.viewer?.email },
  };
}

function missingVars(env: Env, keys: Array<keyof Env>): string[] {
  return keys.filter((key) => !env[key]).map(String);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function getConnectedToken(env: Env, userId: string, provider: OAuthProvider) {
  return first<{ access_token_encrypted: string | null }>(
    env,
    `SELECT access_token_encrypted FROM account_connections
     WHERE user_id = ? AND provider = ? AND status = 'connected'`,
    [userId, provider],
  );
}

// Decrypt a stored provider token for use inside a Workflow step. The plaintext
// must never be returned from a step or logged. See SANDBOX_REVIEW.md S6.
export async function getDecryptedToken(
  env: Env,
  userId: string,
  provider: OAuthProvider,
): Promise<string | null> {
  const row = await getConnectedToken(env, userId, provider);
  if (!row?.access_token_encrypted) {
    return null;
  }
  return decryptText(row.access_token_encrypted, env.TOKEN_ENCRYPTION_KEY);
}

export async function listKnownConnections(env: Env, userId: string) {
  return all(
    env,
    `SELECT provider, status, account_name, updated_at
     FROM account_connections
     WHERE user_id = ?
     ORDER BY provider`,
    [userId],
  );
}
