/* AGPL-3.0-or-later */
export type RepoCandidate = {
  owner: string;
  repo: string;
  url: string;
  source: "project_description" | "issue_link" | "branch" | "metadata";
  confidence: number;
};

const GITHUB_REPO_PATTERN =
  /(?:https?:\/\/github\.com\/|github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:[)\]\s#?]|$)/g;
const OWNER_REPO_PATTERN = /\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\b/g;

export function extractGitHubReposFromText(
  text: string | null | undefined,
  source: RepoCandidate["source"] = "project_description",
): RepoCandidate[] {
  if (!text) {
    return [];
  }

  const candidates = new Map<string, RepoCandidate>();
  for (const match of text.matchAll(GITHUB_REPO_PATTERN)) {
    const owner = match[1] ?? "";
    const repo = cleanRepo(match[2] ?? "");
    addCandidate(candidates, owner, repo, source, 0.95);
  }

  for (const match of text.matchAll(OWNER_REPO_PATTERN)) {
    const owner = match[1] ?? "";
    const repo = cleanRepo(match[2] ?? "");
    if (owner.includes(".") || repo.includes(".")) {
      continue;
    }
    addCandidate(candidates, owner, repo, source, 0.55);
  }

  return [...candidates.values()];
}

export function repoMappingStatus(candidates: RepoCandidate[]): {
  status: "mapped" | "needs_review" | "unmapped";
  best: RepoCandidate | null;
} {
  if (candidates.length === 0) {
    return { status: "unmapped", best: null };
  }

  const sorted = [...candidates].sort((left, right) => right.confidence - left.confidence);
  const best = sorted[0] ?? null;
  const second = sorted[1];

  if (!best) {
    return { status: "unmapped", best: null };
  }

  if (best.confidence >= 0.9 && (!second || best.confidence - second.confidence >= 0.2)) {
    return { status: "mapped", best };
  }

  return { status: "needs_review", best };
}

export function normalizeRepoUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}`;
}

function addCandidate(
  candidates: Map<string, RepoCandidate>,
  owner: string,
  repo: string,
  source: RepoCandidate["source"],
  confidence: number,
) {
  if (!owner || !repo || owner === "http" || owner === "https") {
    return;
  }

  const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const existing = candidates.get(key);
  if (!existing || confidence > existing.confidence) {
    candidates.set(key, {
      owner,
      repo,
      url: normalizeRepoUrl(owner, repo),
      source,
      confidence,
    });
  }
}

function cleanRepo(repo: string): string {
  return repo.replace(/\.git$/i, "").replace(/[),.\]]+$/g, "");
}
