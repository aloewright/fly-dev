/* AGPL-3.0-or-later */
import { describe, expect, it } from "vitest";
import {
  extractGitHubReposFromText,
  normalizeRepoUrl,
  repoMappingStatus,
} from "../worker/src/platform/repo-mapping";

describe("repository mapping", () => {
  it("extracts explicit GitHub repository URLs with high confidence", () => {
    const candidates = extractGitHubReposFromText(
      "Source repo: https://github.com/aloewright/fly-mail and docs in Linear.",
    );

    expect(candidates).toEqual([
      {
        owner: "aloewright",
        repo: "fly-mail",
        url: "https://github.com/aloewright/fly-mail",
        source: "project_description",
        confidence: 0.95,
      },
    ]);
    expect(repoMappingStatus(candidates)).toMatchObject({ status: "mapped" });
  });

  it("marks ambiguous shorthand mappings for review instead of guessing", () => {
    const candidates = extractGitHubReposFromText(
      "Possible repos: aloewright/fly-mail or aloewright/fly-dev.",
    );

    expect(candidates).toHaveLength(2);
    expect(repoMappingStatus(candidates)).toMatchObject({ status: "needs_review" });
  });

  it("normalizes owner and repo names into canonical URLs", () => {
    expect(normalizeRepoUrl("aloewright", "warp-template-apple-multiplatform")).toBe(
      "https://github.com/aloewright/warp-template-apple-multiplatform",
    );
  });
});
