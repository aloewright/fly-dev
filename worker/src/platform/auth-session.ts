/* AGPL-3.0-or-later */
import { createAuth } from "../auth";
import type { CurrentUser, Env } from "../env";
import { ensureUser } from "./data";
import { hmacHex, timingSafeEqual } from "./crypto";

type BetterAuthSession = {
  user?: {
    id?: string;
    email?: string | null;
    name?: string | null;
  };
};

const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

export async function getCurrentUser(request: Request, env: Env): Promise<CurrentUser | null> {
  const betterAuthUser = await getBetterAuthUser(request, env);
  if (betterAuthUser) {
    return ensureUser(env, betterAuthUser);
  }

  // Trusted-proxy identity (e.g. fly.pm SSO). dev.fly.pm is a public custom
  // domain, so raw x-fly-* headers are forgeable. They are only honored when
  // accompanied by a valid HMAC signature from the trusted proxy (shared
  // INTERNAL_API_SECRET). See SANDBOX_REVIEW.md A1.
  const flyIdentity = await verifyFlyIdentity(request, env);
  if (flyIdentity) {
    return ensureUser(env, {
      email: flyIdentity.email,
      name: flyIdentity.name,
      flyUserSlug: slugify(flyIdentity.user),
      authSource: "fly",
    });
  }

  // Local-development convenience only — never trusted in production. Gated on
  // APP_ENV, not on the caller-controlled Host header. See SANDBOX_REVIEW.md A3.
  if (env.APP_ENV !== "production" && isLocalRequest(request)) {
    return ensureUser(env, {
      email: "local@dev.fly.pm",
      name: "Local Dev",
      flyUserSlug: "local-dev",
      authSource: "dev",
    });
  }

  return null;
}

export async function requireUser(request: Request, env: Env): Promise<Response | CurrentUser> {
  const user = await getCurrentUser(request, env);
  if (!user) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }
  return user;
}

// Internal-only routes are authenticated with an HMAC signature over the request
// body. The previously-trusted cf-access-authenticated-user-email header was
// removed because it is forgeable on a public route with no Access policy in
// front of it (SANDBOX_REVIEW.md A2). To re-introduce Cloudflare Access, validate
// the cf-access-jwt-assertion JWT against the Access JWKS endpoint instead.
export async function verifyInternalRequest(request: Request, env: Env): Promise<boolean> {
  if (!env.INTERNAL_API_SECRET) {
    // Fail closed in production; allow unsigned internal calls only in dev.
    return env.APP_ENV !== "production";
  }

  const signature = request.headers.get("x-fly-signature");
  const timestamp = request.headers.get("x-fly-timestamp");
  if (!signature || !timestamp || !isFreshTimestamp(timestamp)) {
    return false;
  }

  const body = request.method === "GET" ? "" : await request.clone().text();
  const expected = await hmacHex(env.INTERNAL_API_SECRET, `${timestamp}.${body}`);
  return timingSafeEqual(signature.replace(/^sha256=/, ""), expected);
}

async function verifyFlyIdentity(
  request: Request,
  env: Env,
): Promise<{ user: string; email: string | null; name: string | null } | null> {
  const flyUser = request.headers.get("x-fly-user");
  const timestamp = request.headers.get("x-fly-timestamp");
  const signature = request.headers.get("x-fly-signature");
  if (!flyUser || !timestamp || !signature || !env.INTERNAL_API_SECRET) {
    return null;
  }
  if (!isFreshTimestamp(timestamp)) {
    return null;
  }
  const expected = await hmacHex(env.INTERNAL_API_SECRET, `${timestamp}.${flyUser}`);
  if (!timingSafeEqual(signature.replace(/^sha256=/, ""), expected)) {
    return null;
  }
  return {
    user: flyUser,
    email: request.headers.get("x-fly-email"),
    name: request.headers.get("x-fly-name"),
  };
}

async function getBetterAuthUser(request: Request, env: Env): Promise<Omit<CurrentUser, "id"> | null> {
  try {
    const auth = createAuth(env);
    const session = (await auth.api.getSession({
      headers: request.headers,
    })) as BetterAuthSession | null;

    if (!session?.user?.id) {
      return null;
    }

    return {
      email: session.user.email ?? null,
      name: session.user.name ?? null,
      // Key on the stable Better Auth user id to avoid slug collisions between
      // different emails that normalize to the same value. See SANDBOX_REVIEW.md A5.
      flyUserSlug: `ba-${session.user.id}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64),
      authSource: "better-auth",
    };
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) {
      return null;
    }
    throw error;
  }
}

function isFreshTimestamp(timestamp: string): boolean {
  const ts = Number(timestamp);
  return Number.isFinite(ts) && Math.abs(Date.now() - ts) <= SIGNATURE_WINDOW_MS;
}

function isLocalRequest(request: Request): boolean {
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/@.*$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}
