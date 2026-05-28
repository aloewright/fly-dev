/* AGPL-3.0-or-later */
export type WorkQueueMessage = {
  runId: string;
  userId: string;
  projectId?: string;
  action: "start-run" | "sync-project" | "deploy-page";
};

export type RunWorkflowParams = {
  runId: string;
  userId: string;
  projectId?: string;
  objective: string;
};

export type Env = {
  ASSETS: Fetcher;
  DB: D1Database;
  CACHE: KVNamespace;
  SESSION_CACHE: KVNamespace;
  ARTIFACTS: R2Bucket;
  TEMPLATE_ASSETS: R2Bucket;
  WORK_QUEUE: Queue<WorkQueueMessage>;
  RUN_WORKFLOW: Workflow<RunWorkflowParams>;
  PROJECT_CONDUCTORS: DurableObjectNamespace;
  USER_WORKER_CONTROLLERS: DurableObjectNamespace;
  DEV_ORCHESTRATOR: DurableObjectNamespace;
  SANDBOX_CONTAINER: DurableObjectNamespace;
  USER_WORKERS: DispatchNamespace;
  AI: Ai;
  MYBROWSER?: unknown;
  APP_ENV: string;
  APP_URL: string;
  AI_GATEWAY_ID: string;
  APPLE_TEMPLATE_REPO: string;
  CLOUDFLARE_TEMPLATE_REPO: string;
  FIRECRAWL_WORKER_URL: string;
  FLY_AUTH_ORIGIN: string;
  PLAYWRIGHT_WORKER_URL: string;
  REQUIRE_HUMAN_APPROVAL: string;
  BETTER_AUTH_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  INTERNAL_API_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  LINEAR_CLIENT_ID?: string;
  LINEAR_CLIENT_SECRET?: string;
  LINEAR_WEBHOOK_SECRET?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
};

export type CurrentUser = {
  id: string;
  email: string | null;
  name: string | null;
  flyUserSlug: string;
  authSource: "fly" | "better-auth" | "dev" | "internal";
};
