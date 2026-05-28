/* AGPL-3.0-or-later */
import { betterAuth } from "better-auth";

type Env = {
  DB: D1Database;
  APP_URL?: string;
  FLY_AUTH_ORIGIN?: string;
  BETTER_AUTH_SECRET?: string;
};

export function createAuth(env: Env) {
  return betterAuth({
    appName: "Fly Dev",
    baseURL: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.APP_URL, env.FLY_AUTH_ORIGIN].filter(
      (origin): origin is string => Boolean(origin),
    ),
    database: env.DB,
    emailAndPassword: {
      enabled: true,
    },
  });
}
