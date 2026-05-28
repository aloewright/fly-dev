/* AGPL-3.0-or-later */

const LINEAR_GRAPHQL = "https://api.linear.app/graphql";

export type LinearWriteBack = {
  issueId: string;
  teamId: string | null;
  prUrl: string | null;
  summary: string;
};

// Write the run result back to the Linear issue: comment with the PR, attach the
// PR, and move the issue to a completed state. Best-effort — callers should treat
// failures as non-fatal. See SANDBOX_REVIEW.md §5.
export async function writeBackToLinear(token: string, input: LinearWriteBack): Promise<void> {
  const comment = input.prUrl
    ? `fly-dev opened a pull request: ${input.prUrl}\n\n${input.summary}`.trim()
    : `fly-dev run completed.\n\n${input.summary}`.trim();

  await linearRequest(token, COMMENT_MUTATION, { issueId: input.issueId, body: comment });

  if (input.prUrl) {
    await linearRequest(token, ATTACHMENT_MUTATION, {
      issueId: input.issueId,
      url: input.prUrl,
      title: "Pull request",
    });
  }

  const doneStateId = await resolveDoneState(token, input.teamId);
  if (doneStateId) {
    await linearRequest(token, ISSUE_STATE_MUTATION, { issueId: input.issueId, stateId: doneStateId });
  }
}

async function resolveDoneState(token: string, teamId: string | null): Promise<string | null> {
  if (!teamId) return null;
  const data = await linearRequest<{ workflowStates?: { nodes?: Array<{ id: string }> } }>(
    token,
    DONE_STATE_QUERY,
    { teamId },
  );
  return data?.workflowStates?.nodes?.[0]?.id ?? null;
}

async function linearRequest<T = unknown>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T | null> {
  const res = await fetch(LINEAR_GRAPHQL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { data?: T };
  return json.data ?? null;
}

const COMMENT_MUTATION =
  `mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }`;
const ATTACHMENT_MUTATION =
  `mutation($issueId: String!, $url: String!, $title: String!) { attachmentCreate(input: { issueId: $issueId, url: $url, title: $title }) { success } }`;
const ISSUE_STATE_MUTATION =
  `mutation($issueId: String!, $stateId: String!) { issueUpdate(id: $issueId, input: { stateId: $stateId }) { success } }`;
const DONE_STATE_QUERY =
  `query($teamId: String!) { workflowStates(filter: { team: { id: { eq: $teamId } }, type: { eq: "completed" } }) { nodes { id name } } }`;
