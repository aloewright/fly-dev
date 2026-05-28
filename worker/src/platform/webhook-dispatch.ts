/* AGPL-3.0-or-later */
import type { Env } from "../env";
import { ensureUser } from "./data";
import { createTaskRun } from "./orchestration";

// Map inbound provider webhooks to task runs. Runs created here still pass
// through createTaskRun's approval gate (REQUIRE_HUMAN_APPROVAL), so a webhook
// only *queues* work for human review — it never auto-mutates a repo unless
// auto-approval is explicitly enabled. See SANDBOX_REVIEW.md §C item 1.

// Linear: trigger on an Issue entering a "started" state or carrying a `fly-dev`
// label.
export async function dispatchFromLinearWebhook(env: Env, payload: Record<string, unknown>): Promise<void> {
  if (stringField(payload, "type") !== "Issue") return;
  const action = stringField(payload, "action");
  if (action !== "create" && action !== "update") return;

  const data = asObject(payload.data);
  const state = asObject(data.state);
  const labels = Array.isArray(data.labels) ? (data.labels as unknown[]).map(asObject) : [];
  const triggered =
    stringField(state, "type") === "started" ||
    labels.some((label) => stringField(label, "name")?.toLowerCase() === "fly-dev");
  if (!triggered) return;

  const issueId = stringField(data, "id");
  const title = stringField(data, "title");
  if (!issueId || !title) return;

  const description = stringField(data, "description") ?? "";
  const team = asObject(data.team);
  const user = await ensureUser(env, {
    email: null,
    name: "Fly Webhook",
    flyUserSlug: "internal",
    authSource: "internal",
  });

  await createTaskRun(env, user, {
    objective: `${title}\n\n${description}`.trim(),
    linearProjectId: stringField(data, "projectId") ?? undefined,
    linearIssueId: issueId,
    linearTeamId: stringField(team, "id") ?? undefined,
    agentProvider: "claude-code",
    source: "linear-webhook",
  });
}

// GitHub: trigger on an issue/PR comment containing `/claude` or `/codex`.
export async function dispatchFromGitHubWebhook(env: Env, payload: Record<string, unknown>): Promise<void> {
  const comment = asObject(payload.comment);
  const body = stringField(comment, "body");
  if (!body || !/\/(claude|codex)\b/i.test(body)) return;

  const repository = asObject(payload.repository);
  const fullName = stringField(repository, "full_name");
  const issue = asObject(payload.issue);
  const title = stringField(issue, "title");
  if (!fullName || !title) return;

  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) return;

  const user = await ensureUser(env, {
    email: null,
    name: "Fly Webhook",
    flyUserSlug: "internal",
    authSource: "internal",
  });

  await createTaskRun(env, user, {
    objective: `${title}\n\n${body.replace(/\/(claude|codex)\b/gi, "").trim()}`.trim(),
    repoOwner: owner,
    repoName: repo,
    agentProvider: /\/codex\b/i.test(body) ? "codex" : "claude-code",
    source: "github-webhook",
  });
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
