/* AGPL-3.0-or-later */
import { Agent, routeAgentRequest } from "agents";
import { Container, getContainer } from "@cloudflare/containers";
import { Hono } from "hono";
import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { createAuth } from "./auth";
import type { CurrentUser, Env, RunWorkflowParams, WorkQueueMessage } from "./env";
import { getCurrentUser, requireUser, verifyInternalRequest } from "./platform/auth-session";
import {
  all,
  first,
  getOverview,
  getProjects,
  getRuns,
  id,
  recordRunEvent,
  recordUsage,
} from "./platform/data";
import {
  createOAuthConnectUrl,
  handleOAuthCallback,
  storeWebhook,
  syncLinearProjectFromPayload,
  verifyWebhook,
  type OAuthProvider,
} from "./platform/integrations";
import {
  approveRun,
  cancelRun,
  createTaskRun,
  createTemplateApp,
  markRunFailed,
  markRunStarted,
  startRunWorkflow,
} from "./platform/orchestration";
import { redactSecrets } from "./platform/crypto";

const app = new Hono<{ Bindings: Env; Variables: { user: CurrentUser | null } }>();

app.use("*", async (c, next) => {
  const user = await getCurrentUser(c.req.raw, c.env);
  c.set("user", user);
  await next();
});

app.get("/api/health", (c) => {
  return c.json({
    ok: true,
    service: "fly-dev",
    url: c.env.APP_URL,
    bindings: {
      d1: Boolean(c.env.DB),
      r2: Boolean(c.env.ARTIFACTS),
      kv: Boolean(c.env.CACHE),
      queue: Boolean(c.env.WORK_QUEUE),
      workflow: Boolean(c.env.RUN_WORKFLOW),
      userWorkers: Boolean(c.env.USER_WORKERS),
      aiGateway: Boolean(c.env.AI),
      browser: Boolean(c.env.MYBROWSER),
    },
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/me", async (c) => {
  return c.json(c.get("user"));
});

app.get("/api/overview", async (c) => {
  return c.json(await getOverview(c.env, c.get("user")));
});

app.get("/api/usage", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Authentication required" }, 401);
  }
  return c.json((await getOverview(c.env, user)).usage);
});

app.get("/api/projects", async (c) => {
  return c.json({ projects: await getProjects(c.env) });
});

// AI Gateway smoke test endpoints.
// `?route=binding` (default) uses the sanctioned working pattern from
// ~/.claude/CLAUDE.md: env.AI.run("@cf/<model>", ..., { gateway: { id } }).
// `?route=dynamic` tries `dynamic/text_gen` to re-confirm the upstream
// Worker-side bug and detect when it's fixed.
const AI_TEST_MODEL = "@cf/openai/gpt-oss-120b";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

async function runAi(
  env: Env,
  route: "binding" | "dynamic",
  messages: ChatMessage[],
  maxTokens: number,
) {
  const gatewayId = env.AI_GATEWAY_ID || "x";
  const model = route === "dynamic" ? "dynamic/text_gen" : AI_TEST_MODEL;
  const raw = await (env.AI as unknown as {
    run: (m: string, i: unknown, o: { gateway: { id: string } }) => Promise<unknown>;
  }).run(model, { messages, max_tokens: maxTokens }, { gateway: { id: gatewayId } });
  return { gatewayId, model, raw };
}

app.get("/api/ai/ping", async (c) => {
  const route = c.req.query("route") === "dynamic" ? "dynamic" : "binding";
  const startedAt = Date.now();
  try {
    const { gatewayId, model, raw } = await runAi(
      c.env,
      route,
      [
        { role: "system", content: "Reply with exactly the single word: pong" },
        { role: "user", content: "ping" },
      ],
      64,
    );
    return c.json({ ok: true, route, model, gatewayId, ms: Date.now() - startedAt, response: raw });
  } catch (err) {
    return c.json(
      {
        ok: false,
        route,
        ms: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});

app.post("/api/ai/chat", async (c) => {
  const body = await c.req
    .json<{
      prompt?: string;
      messages?: ChatMessage[];
      route?: "binding" | "dynamic";
      maxTokens?: number;
    }>()
    .catch(() => ({}) as Record<string, never>);
  const route = body.route === "dynamic" ? "dynamic" : "binding";
  const maxTokens = typeof body.maxTokens === "number" ? body.maxTokens : 256;
  const messages =
    body.messages ?? (body.prompt ? [{ role: "user" as const, content: body.prompt }] : null);
  if (!messages || messages.length === 0) {
    return c.json({ error: "Provide `prompt` (string) or `messages` (array)" }, 400);
  }
  const startedAt = Date.now();
  try {
    const { gatewayId, model, raw } = await runAi(c.env, route, messages, maxTokens);
    return c.json({ ok: true, route, model, gatewayId, ms: Date.now() - startedAt, response: raw });
  } catch (err) {
    return c.json(
      {
        ok: false,
        route,
        ms: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});

app.get("/api/projects/:id/runs", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  return c.json({ runs: await getRuns(c.env, user.id, c.req.param("id")) });
});

app.get("/api/runs/:id/events", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  const run = await first<{ id: string }>(
    c.env,
    "SELECT id FROM runs WHERE id = ? AND user_id = ?",
    [c.req.param("id"), user.id],
  );
  if (!run) {
    return c.json({ error: "Run not found" }, 404);
  }
  const events = await all(
    c.env,
    `SELECT id, event_type AS eventType, message, severity, metadata_json AS metadataJson, created_at AS createdAt
     FROM run_events
     WHERE run_id = ?
     ORDER BY created_at ASC, id ASC`,
    [run.id],
  );
  return c.json({ events });
});

app.post("/api/tasks", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  return createTaskRun(c.env, user, await c.req.json());
});

app.post("/api/runs/:id/approve", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  return approveRun(c.env, user, c.req.param("id"));
});

app.post("/api/runs/:id/cancel", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  return cancelRun(c.env, user, c.req.param("id"));
});

app.get("/api/integrations/:provider/connect", async (c) => {
  const provider = c.req.param("provider") as OAuthProvider;
  if (!isOAuthProvider(provider)) {
    return c.json({ error: "Unsupported provider" }, 400);
  }
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  const result = await createOAuthConnectUrl(provider, c.req.raw, c.env, user);
  if (result.setupRequired || c.req.query("format") === "json") {
    return c.json(result);
  }
  return c.redirect(result.url);
});

app.get("/api/integrations/:provider/callback", async (c) => {
  const provider = c.req.param("provider") as OAuthProvider;
  if (!isOAuthProvider(provider)) {
    return c.json({ error: "Unsupported provider" }, 400);
  }
  return handleOAuthCallback(provider, c.req.raw, c.env);
});

app.post("/api/webhooks/:provider", async (c) => {
  const provider = c.req.param("provider") as OAuthProvider;
  if (!isOAuthProvider(provider)) {
    return c.json({ error: "Unsupported provider" }, 400);
  }

  const body = await c.req.text();
  const signatureValid = await verifyWebhook(provider, c.req.raw, c.env, body);
  const eventId =
    c.req.header("x-github-delivery") ?? c.req.header("linear-delivery") ?? c.req.header("x-linear-delivery") ?? null;
  const eventType = c.req.header("x-github-event") ?? c.req.header("linear-event") ?? null;
  await storeWebhook(c.env, provider, body, signatureValid, eventId, eventType);

  if (!signatureValid) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  if (provider === "linear") {
    await syncLinearProjectFromPayload(c.env, JSON.parse(body) as Record<string, unknown>);
  }

  return c.json({ ok: true });
});

app.post("/api/templates/apps", async (c) => {
  const user = await requireUser(c.req.raw, c.env);
  if (user instanceof Response) return user;
  return createTemplateApp(c.env, user, await c.req.json());
});

app.get("/api/internal/status", async (c) => {
  if (!(await verifyInternalRequest(c.req.raw, c.env))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const overview = await getOverview(c.env, c.get("user"));
  return c.json({
    ok: true,
    activeRuns: overview.recentRuns.filter((run) => ["queued", "running", "waiting_approval"].includes(run.status)).length,
    failedRuns: overview.recentRuns.filter((run) => run.status === "failed").length,
    usage: overview.usage,
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/internal/pages-deploy", async (c) => {
  if (!(await verifyInternalRequest(c.req.raw, c.env))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const body = (await c.req.json()) as { projectName?: string; branch?: string; artifactKey?: string };
  if (!body.projectName) {
    return c.json({ error: "projectName is required" }, 400);
  }
  const eventId = id("deploy");
  await c.env.CACHE.put(`pages-deploy:${eventId}`, JSON.stringify(body), { expirationTtl: 86_400 });
  return c.json({
    id: eventId,
    status: "accepted",
    note: "Pages deployment request recorded for the next sandbox-capable run.",
  }, 202);
});

app.post("/api/internal/summon", async (c) => {
  if (!(await verifyInternalRequest(c.req.raw, c.env))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const localUser = await c.get("user") ?? {
    id: "internal",
    email: null,
    name: "Fly Internal",
    flyUserSlug: "internal",
    authSource: "internal" as const,
  };
  return createTaskRun(c.env, localUser, await c.req.json());
});

app.on(["GET", "POST"], "/api/auth/*", (c) => {
  const auth = createAuth(c.env);
  return auth.handler(c.req.raw);
});

app.all("/agents/orchestrator/:flyUserId", async (c) => {
  const flyUserId = c.req.param("flyUserId");
  const stub = c.env.DEV_ORCHESTRATOR.get(c.env.DEV_ORCHESTRATOR.idFromName(flyUserId));
  return stub.fetch(c.req.raw);
});

app.get("*", async (c) => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith("/api/") || path.startsWith("/agents/")) {
    return c.json({ error: "Not found" }, 404);
  }

  const asset = await c.env.ASSETS.fetch(c.req.raw);
  if (asset.status !== 404) {
    return asset;
  }

  const indexUrl = new URL("/index.html", c.req.url);
  return c.env.ASSETS.fetch(new Request(indexUrl, c.req.raw));
});

export class DevOrchestratorAgent extends Agent<Env, { lastGoal?: string }> {
  initialState = {};

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST") {
      const payload = (await request.json()) as { goal?: string; task?: string };
      const goal = redactSecrets((payload.goal ?? payload.task ?? "").trim());
      this.setState({ lastGoal: goal });
      return Response.json({
        ok: true,
        agent: "dev-orchestrator",
        user: this.name,
        goal,
        plan: goal
          ? [
              "Inspect connected Linear project and repository mapping.",
              "Draft or update Linear issues for the goal.",
              "Queue a sandbox run after approval.",
            ]
          : [],
      });
    }

    return Response.json({
      ok: true,
      agent: "dev-orchestrator",
      user: this.name,
      memory: {
        sessionAffinity: this.sessionAffinity,
        lastGoal: this.state.lastGoal ?? null,
      },
      route: url.pathname,
    });
  }
}

export class ProjectConductor extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const projectId = this.ctx.id.name ?? url.searchParams.get("projectId") ?? "unknown";
    if (request.method === "POST") {
      const message = (await request.json()) as WorkQueueMessage;
      await this.ctx.storage.put(`last:${message.runId}`, message);
      return Response.json({ ok: true, projectId, accepted: message });
    }
    const runs = await this.ctx.storage.list({ prefix: "last:" });
    return Response.json({ ok: true, projectId, recentMessages: [...runs.values()] });
  }
}

export class UserWorkerController extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const flyUserId = this.ctx.id.name ?? "unknown";
    if (url.pathname.endsWith("/dispatch") && request.method === "POST") {
      const body = (await request.json()) as { workerName?: string; path?: string };
      if (!body.workerName) {
        return Response.json({ error: "workerName is required" }, { status: 400 });
      }
      const worker = this.env.USER_WORKERS.get(body.workerName, { flyUserId });
      const target = new URL(body.path ?? "/", "https://dev.fly.pm");
      return worker.fetch(new Request(target, { method: "GET" }));
    }
    return Response.json({ ok: true, flyUserId, namespace: "fly-dev-production" });
  }
}

export class SandboxContainer extends Container<Env> {
  defaultPort = 8080;
  requiredPorts = [8080];
  sleepAfter = "10m";
  envVars = {
    NODE_ENV: "production",
    FLY_DEV_SANDBOX: "true",
  };
  entrypoint = ["node", "/app/server.mjs"];
  enableInternet = false;
  allowedHosts = [
    "api.github.com",
    "github.com",
    "api.linear.app",
    "gateway.ai.cloudflare.com",
    "firecrawl-cf.lazee.workers.dev",
  ];
  pingEndpoint = "localhost:8080/ready";
}

export class RunWorkflow extends WorkflowEntrypoint<Env, RunWorkflowParams> {
  async run(event: WorkflowEvent<RunWorkflowParams>, step: WorkflowStep) {
    const payload = event.payload;
    if (!payload?.runId || !payload.userId) {
      throw new NonRetryableError("Run workflow requires runId and userId");
    }

    const sandboxId = await step.do("reserve sandbox", async () => {
      const sandboxIdValue = `run-${payload.runId}`;
      await markRunStarted(this.env, payload.runId, sandboxIdValue);
      return sandboxIdValue;
    });

    await step.do("start sandbox container", async () => {
      const containerNamespace = this.env.SANDBOX_CONTAINER as unknown as DurableObjectNamespace<Container<Env>>;
      const container = getContainer(containerNamespace, sandboxId);
      await container.startAndWaitForPorts([8080], {
        instanceGetTimeoutMS: 30_000,
        portReadyTimeoutMS: 30_000,
        waitInterval: 1_000,
      });
    });

    await step.do("record handoff", async () => {
      await recordRunEvent(
        this.env,
        payload.runId,
        "agent.handoff",
        "Sandbox is ready for CLI agent execution. Human-safe v1 stops before mutating repositories.",
        "info",
        { objective: payload.objective },
      );
      await recordUsage(this.env, payload.userId, "container_runtime", {
        runId: payload.runId,
        projectId: payload.projectId,
        quantity: 1,
        unit: "minute",
        provider: "cloudflare-containers",
      });
    });

    return { runId: payload.runId, sandboxId, status: "ready_for_execution" };
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/agents/")) {
      const routed = await routeAgentRequest(request, env).catch(() => null);
      if (routed) return routed;
    }
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<WorkQueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        if (message.body.action === "start-run") {
          const run = await first<{ objective: string }>(
            env,
            "SELECT objective FROM runs WHERE id = ?",
            [message.body.runId],
          );
          await startRunWorkflow(env, {
            runId: message.body.runId,
            userId: message.body.userId,
            projectId: message.body.projectId,
            objective: run?.objective ?? "Continue queued fly-dev run",
          });
          message.ack();
        }
      } catch (error) {
        await markRunFailed(env, message.body.runId, error);
        message.retry();
      }
    }
  },
};

function isOAuthProvider(value: string): value is OAuthProvider {
  return value === "github" || value === "linear";
}
