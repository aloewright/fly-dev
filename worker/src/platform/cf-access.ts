/* AGPL-3.0-or-later */
// Cloudflare Access (Zero Trust) identity verification.
//
// When dev.fly.pm is fronted by a Cloudflare Access self-hosted application,
// the edge authenticates the user (One-time PIN / configured IdP) and forwards
// a signed JWT to this Worker. We validate that JWT against the team's public
// JWKS and the application's AUD tag, then derive the user's email.
//
// This replaces app-managed credentials entirely: there is no password and no
// OAuth client secret in this codebase — Cloudflare runs the login. The Worker
// only trusts a cryptographically verified assertion.
//
// Required (non-secret) config, set as wrangler vars:
//   CF_ACCESS_TEAM_DOMAIN  e.g. "aloewright.cloudflareaccess.com"
//   CF_ACCESS_AUD          the Access application's Application Audience tag
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Env } from "../env";

export type CfAccessIdentity = {
  email: string;
  name: string | null;
  sub: string;
};

// createRemoteJWKSet caches keys in-memory and refetches on a kid miss. Cache
// the set per team domain across requests within an isolate to avoid refetching
// the JWKS on every request.
const jwksByTeam = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksByTeam.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksByTeam.set(teamDomain, jwks);
  }
  return jwks;
}

// Access forwards the assertion as a header on enforced paths. On Access-bypassed
// paths the header is absent, but the CF_Authorization cookie (the same JWT) is
// still sent on same-domain browser requests, so fall back to it.
function readAccessToken(request: Request): string | null {
  const header = request.headers.get("cf-access-jwt-assertion");
  if (header) {
    return header;
  }
  const cookie = request.headers.get("cookie");
  if (!cookie) {
    return null;
  }
  const match = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  const value = match?.[1];
  return value ? decodeURIComponent(value) : null;
}

export async function getCfAccessIdentity(
  request: Request,
  env: Env,
): Promise<CfAccessIdentity | null> {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  const aud = env.CF_ACCESS_AUD;
  if (!teamDomain || !aud) {
    return null;
  }

  const token = readAccessToken(request);
  if (!token) {
    return null;
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, getJwks(teamDomain), {
      issuer: `https://${teamDomain}`,
      audience: aud,
    }));
  } catch {
    // Invalid, expired, wrong-audience, or unsigned token: treat as anonymous.
    return null;
  }

  const email = typeof payload.email === "string" ? payload.email : null;
  if (!email) {
    return null;
  }

  return {
    email,
    name: typeof payload.name === "string" ? payload.name : null,
    sub: typeof payload.sub === "string" ? payload.sub : email,
  };
}
