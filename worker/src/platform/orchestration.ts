/* AGPL-3.0-or-later */
import type { CurrentUser, Env, RunWorkflowParams, WorkQueueMessage } from "../env";
import { id, recordRunEvent, recordUsage, runSql } from "./data";
import { redactSecrets } from "./crypto";

export type CreateTaskPayload = {
  objective?: string;
  goal?: string;
  linearProjectId?: string;
  repoMappingId?: string;
  agentProvider?: "codex" | "claude-code";
  autonomyMode?: "manual_approval" | "auto_review" | "auto_eligible";
};

export type CreateTemplateAppPayload = {
  kind?: "cloudflare-fullstack" | "apple-multiplatform";
  linearProjectId?: string;
  repoName?: string;
  visibility?: "public" | "private" | "internal";
};

export async function createTaskRun(env: Env, user: CurrentUser, payload: CreateTaskPayload) {
  const objective = redactSecrets((payload.objective ?? payload.goal ?? "").trim());
  if (objective.length < 4) {
    return Response.json({ error: "Task objective is required" }, { status: 400 });
  }

  const runId = id("run");
  const approvalRequired = payload.autonomyMode === "auto_eligible" ? 0 : 1;
  const status = approvalRequired ? "waiting_approval" : "queued";

  await runSql(
    env,
    `INSERT INTO runs
       (id, user_id, project_id, repo_mapping_id, objective, status, autonomy_mode, agent_provider, approval_required, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      runId,
      user.id,
      payload.linearProjectId ?? null,
      payload.repoMappingId ?? null,
      objective,
      status,
      payload.autonomyMode ?? "manual_approval",
      payload.agentProvider ?? "codex",
      approvalRequired,
      JSON.stringify({ source: "dev.fly.pm" }),
    ],
  );

  await recordRunEvent(
    env,
    runId,
    "run.created",
    approvalRequired
      ? "Run created and waiting for human approval."
      : "Run created and queued for sandbox execution.",
    "info",
    { approvalRequired: Boolean(approvalRequired) },
  );
  await recordUsage(env, user.id, "orchestration_event", {
    runId,
    projectId: payload.linearProjectId,
    metadata: { action: "create_task" },
  });

  if (!approvalRequired) {
    await enqueueRun(env, {
      runId,
      userId: user.id,
      projectId: payload.linearProjectId,
      action: "start-run",
    });
  }

  return Response.json({ id: runId, status, approvalRequired: Boolean(approvalRequired) }, { status: 201 });
}

export async function approveRun(env: Env, user: CurrentUser, runId: string) {
  await runSql(
    env,
    `UPDATE runs
     SET status = 'queued', approval_required = 0, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ?`,
    [runId, user.id],
  );
  await runSql(
    env,
    `INSERT INTO approvals (id, run_id, user_id, action, status, decided_at)
     VALUES (?, ?, ?, 'start-run', 'approved', CURRENT_TIMESTAMP)`,
    [id("approval"), runId, user.id],
  );
  await recordRunEvent(env, runId, "run.approved", "Human approval received; run queued.", "info");
  await enqueueRun(env, { runId, userId: user.id, action: "start-run" });
  return Response.json({ id: runId, status: "queued" });
}

export async function cancelRun(env: Env, user: CurrentUser, runId: string) {
  await runSql(
    env,
    `UPDATE runs
     SET status = 'cancelled', finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ? AND status IN ('queued', 'waiting_approval', 'running')`,
    [runId, user.id],
  );
  await recordRunEvent(env, runId, "run.cancelled", "Run cancelled by user.", "warn");
  return Response.json({ id: runId, status: "cancelled" });
}

export async function createTemplateApp(
  env: Env,
  user: CurrentUser,
  payload: CreateTemplateAppPayload,
) {
  if (!payload.kind || !payload.repoName || !payload.linearProjectId) {
    return Response.json(
      { error: "kind, repoName, and linearProjectId are required" },
      { status: 400 },
    );
  }

  const templateRepo =
    payload.kind === "cloudflare-fullstack" ? env.CLOUDFLARE_TEMPLATE_REPO : env.APPLE_TEMPLATE_REPO;
  const objective =
    `Create ${payload.kind} app repo ${payload.repoName} from ${templateRepo}, ` +
    `link it to Linear project ${payload.linearProjectId}, and prepare the first verified run.`;

  const response = await createTaskRun(env, user, {
    objective,
    linearProjectId: payload.linearProjectId,
    agentProvider: "codex",
    autonomyMode: "manual_approval",
  });

  await recordUsage(env, user.id, "template_app_request", {
    projectId: payload.linearProjectId,
    metadata: {
      kind: payload.kind,
      repoName: payload.repoName,
      visibility: payload.visibility ?? "private",
      templateRepo,
    },
  });

  return response;
}

export async function startRunWorkflow(env: Env, params: RunWorkflowParams): Promise<void> {
  await env.RUN_WORKFLOW.create({
    id: params.runId,
    params,
    retention: {
      successRetention: "30 days",
      errorRetention: "90 days",
    },
  });
}

export async function enqueueRun(env: Env, message: WorkQueueMessage): Promise<void> {
  await env.WORK_QUEUE.send(message);
}

export async function markRunStarted(env: Env, runId: string, sandboxId: string): Promise<void> {
  await runSql(
    env,
    `UPDATE runs
     SET status = 'running', sandbox_id = ?, started_at = COALESCE(started_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [sandboxId, runId],
  );
  await recordRunEvent(env, runId, "container.start", "Sandbox container start requested.", "info", {
    sandboxId,
  });
}

export async function markRunFailed(env: Env, runId: string, error: unknown): Promise<void> {
  const message = redactSecrets(error instanceof Error ? error.message : String(error));
  await runSql(
    env,
    `UPDATE runs
     SET status = 'failed', last_error = ?, finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [message, runId],
  );
  await recordRunEvent(env, runId, "run.failed", message, "error");
}
