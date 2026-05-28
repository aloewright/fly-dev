/* AGPL-3.0-or-later */
// In-sandbox agent runner. Receives a per-run job over POST /run (objective,
// repo, ephemeral tokens, AI Gateway config), clones the repo, runs the coding
// agent (claude-code / codex) routed through the AI Gateway, opens a PR, and
// returns a structured result. Secrets arrive only in the request body and are
// passed to the agent subprocess as env vars — never baked into the image.
// See SANDBOX_REVIEW.md §4.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = Number(process.env.PORT ?? 8080);
const AGENT_TIMEOUT_MS = 8 * 60 * 1000;
const GIT_TIMEOUT_MS = 2 * 60 * 1000;

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function exec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 60_000);
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err) });
    });
  });
}

// Build the agent subprocess env. Routes model calls through Cloudflare AI
// Gateway — never a raw provider key/endpoint. See ~/.claude/CLAUDE.md.
function buildAgentEnv(job) {
  const env = { HOME: "/tmp", IS_SANDBOX: "1" };
  const gw = job.aiGateway;
  if (gw?.url) {
    // claude-code (Anthropic Messages format) → gateway anthropic passthrough.
    env.ANTHROPIC_BASE_URL = gw.url;
    env.ANTHROPIC_AUTH_TOKEN = "gateway";
    // The gateway authorization travels as a header; the upstream provider key
    // is supplied by the gateway (BYOK), so no raw provider key is in here.
    if (gw.token) env.ANTHROPIC_CUSTOM_HEADERS = `cf-aig-authorization: Bearer ${gw.token}`;
    env.OPENAI_BASE_URL = gw.url;
  }
  if (job.linearToken) env.LINEAR_API_KEY = job.linearToken;
  return env;
}

function agentCommand(job) {
  if (job.agentProvider === "codex") {
    return { cmd: "codex", args: ["exec", "--full-auto", job.objective] };
  }
  return {
    cmd: "claude",
    args: ["--print", "--permission-mode", "bypassPermissions", "--max-turns", "30", job.objective],
  };
}

async function openPullRequest(job, head, base, title, summary) {
  const res = await fetch(`https://api.github.com/repos/${job.repo.owner}/${job.repo.repo}/pulls`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${job.githubToken}`,
      accept: "application/vnd.github+json",
      "user-agent": "fly-dev",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({
      title,
      head,
      base,
      body: `## Summary\n\n${summary || "_(no summary)_"}\n\n---\n_Opened automatically by fly-dev run ${job.runId}._`,
    }),
  });
  if (!res.ok) {
    return { ok: false, status: res.status, text: (await res.text()).slice(0, 500) };
  }
  const json = await res.json();
  return { ok: true, prUrl: json.html_url, prNumber: json.number };
}

async function handleRun(rawBody) {
  let job;
  try {
    job = JSON.parse(rawBody);
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  if (!job.runId || !job.objective || !job.repo?.owner || !job.repo?.repo || !job.githubToken) {
    return { ok: false, error: "missing_required_fields" };
  }

  const baseBranch = job.repo.baseBranch || "main";
  const branch = `fly-dev/${job.runId}`;
  const workdir = await mkdtemp(path.join(tmpdir(), `fly-${job.runId}-`));
  const repoDir = path.join(workdir, job.repo.repo);
  const cloneUrl = `https://x-access-token:${job.githubToken}@github.com/${job.repo.owner}/${job.repo.repo}.git`;

  try {
    const clone = await exec(
      "git",
      ["clone", "--depth=1", "--branch", baseBranch, cloneUrl, repoDir],
      { timeoutMs: GIT_TIMEOUT_MS },
    );
    if (clone.code !== 0) {
      return { ok: false, error: "clone_failed", logs: clone.stderr.slice(-4000) };
    }

    await exec("git", ["checkout", "-b", branch], { cwd: repoDir });
    await exec("git", ["config", "user.email", "fly-dev[bot]@users.noreply.github.com"], { cwd: repoDir });
    await exec("git", ["config", "user.name", "fly-dev[bot]"], { cwd: repoDir });

    const { cmd, args } = agentCommand(job);
    const agent = await exec(cmd, args, {
      cwd: repoDir,
      env: buildAgentEnv(job),
      timeoutMs: AGENT_TIMEOUT_MS,
    });
    const summary = (agent.stdout || "").slice(-4000);
    const logs = (agent.stderr || "").slice(-4000);

    const status = await exec("git", ["status", "--porcelain"], { cwd: repoDir });
    if (!status.stdout.trim()) {
      return { ok: false, error: "no_changes", summary, logs };
    }

    await exec("git", ["add", "-A"], { cwd: repoDir });
    const title = `feat: ${job.objective}`.slice(0, 72);
    const commit = await exec(
      "git",
      ["commit", "-m", `${title}\n\n[fly-dev run ${job.runId}]`],
      { cwd: repoDir },
    );
    if (commit.code !== 0) {
      return { ok: false, error: "commit_failed", logs: commit.stderr.slice(-2000), summary };
    }

    const push = await exec("git", ["push", "origin", branch], { cwd: repoDir, timeoutMs: GIT_TIMEOUT_MS });
    if (push.code !== 0) {
      return { ok: false, error: "push_failed", logs: push.stderr.slice(-2000), summary };
    }

    const head = await exec("git", ["rev-parse", "HEAD"], { cwd: repoDir });
    const commitSha = head.stdout.trim();
    const diff = (
      await exec("git", ["diff", `${baseBranch}...${branch}`], { cwd: repoDir, timeoutMs: 30_000 })
    ).stdout.slice(0, 50_000);

    const pr = await openPullRequest(job, branch, baseBranch, title, summary);
    if (!pr.ok) {
      return {
        ok: false,
        error: "pr_failed",
        branch,
        commitSha,
        diff,
        summary,
        logs: `PR create HTTP ${pr.status}: ${pr.text}`,
      };
    }

    return {
      ok: true,
      prUrl: pr.prUrl,
      prNumber: pr.prNumber,
      branch,
      commitSha,
      diff,
      summary,
      logs,
    };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

const server = http.createServer(async (request, response) => {
  if (request.url === "/ready") {
    return sendJson(response, 200, { ok: true, runtime: "fly-dev-sandbox" });
  }
  if (request.method === "POST" && request.url === "/run") {
    try {
      const body = await readBody(request);
      const result = await handleRun(body);
      return sendJson(response, 200, result);
    } catch (err) {
      return sendJson(response, 200, { ok: false, error: "exception", message: String(err) });
    }
  }
  return sendJson(response, 404, { error: "not_found" });
});

server.listen(PORT, "0.0.0.0");
