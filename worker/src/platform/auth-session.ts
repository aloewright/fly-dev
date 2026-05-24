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

export async function getCurrentUser(request: Request, env: Env): Promise<CurrentUser | null> {
  const betterAuthUser = await getBetterAuthUser(request, env);
  if (betterAuthUser) {
    return ensureUser(env, betterAuthUser);
  }

  const flySlug = request.headers.get("x-fly-user") ?? cookie(request, "fly_user");
  if (flySlug) {
    return ensureUser(env, {
      email: request.headers.get("x-fly-email"),
      name: request.headers.get("x-fly-name"),
      flyUserSlug: slugify(flySlug),
      authSource: "fly",
    });
  }

  const hostname = new URL(request.url).hostname;
  const hostHeader = request.headers.get("host") ?? "";
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostHeader.startsWith("localhost:") ||
    hostHeader.startsWith("127.0.0.1:")
  ) {
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

export async function verifyInternalRequest(request: Request, env: Env): Promise<boolean> {
  const accessEmail = request.headers.get("cf-access-authenticated-user-email");
  if (accessEmail) {
    return true;
  }

  if (!env.INTERNAL_API_SECRET && env.APP_ENV !== "production") {
    return true;
  }

  const signature = request.headers.get("x-fly-signature");
  const timestamp = request.headers.get("x-fly-timestamp");
  if (!env.INTERNAL_API_SECRET || !signature || !timestamp) {
    return false;
  }

  const body = request.method === "GET" ? "" : await request.clone().text();
  const expected = await hmacHex(env.INTERNAL_API_SECRET, `${timestamp}.${body}`);
  return timingSafeEqual(signature.replace(/^sha256=/, ""), expected);
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
      flyUserSlug: slugify(session.user.email ?? session.user.id),
      authSource: "better-auth",
    };
  } catch (error) {
    if (error instanceof Error && /no such table|D1_ERROR/i.test(error.message)) {
      return null;
    }
    throw error;
  }
}

function cookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) {
    return null;
  }

  for (const part of header.split(";")) {
    const [key, value] = part.trim().split("=");
    if (key === name && value) {
      return decodeURIComponent(value);
    }
  }
  return null;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/@.*$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}
