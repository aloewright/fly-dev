/* AGPL-3.0-or-later */
import type { Env } from "../env";

// Mint a GitHub App installation token scoped to a single repository with
// least-privilege permissions. This keeps the broad user OAuth token out of the
// code-executing sandbox. Returns null when no GitHub App is configured (the
// caller falls back to the user's OAuth token). See SANDBOX_REVIEW.md S3.
export async function getInstallationToken(
  env: Env,
  owner: string,
  repo: string,
): Promise<string | null> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    return null;
  }

  const appJwt = await mintAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);

  const installation = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/installation`,
    { headers: ghHeaders(appJwt) },
  );
  if (!installation.ok) {
    return null;
  }
  const { id: installationId } = (await installation.json()) as { id?: number };
  if (!installationId) {
    return null;
  }

  const tokenResponse = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: { ...ghHeaders(appJwt), "content-type": "application/json" },
      body: JSON.stringify({
        repositories: [repo],
        permissions: { contents: "write", pull_requests: "write" },
      }),
    },
  );
  if (!tokenResponse.ok) {
    return null;
  }
  const { token } = (await tokenResponse.json()) as { token?: string };
  return token ?? null;
}

function ghHeaders(bearer: string): Record<string, string> {
  return {
    authorization: `Bearer ${bearer}`,
    accept: "application/vnd.github+json",
    "user-agent": "fly-dev",
    "x-github-api-version": "2022-11-28",
  };
}

async function mintAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 30, exp: now + 9 * 60, iss: appId };
  const signingInput = `${base64urlText(JSON.stringify(header))}.${base64urlText(JSON.stringify(payload))}`;
  const key = await importPkcs8(privateKeyPem);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64urlBytes(new Uint8Array(signature))}`;
}

async function importPkcs8(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function base64urlText(value: string): string {
  return base64urlBytes(new TextEncoder().encode(value));
}

function base64urlBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
