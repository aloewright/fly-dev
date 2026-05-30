/* AGPL-3.0-or-later */
import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { fetchJson } from "@/lib/api";

type Overview = {
  user: {
    email: string | null;
    name: string | null;
    flyUserSlug: string;
    authSource: string;
  } | null;
  usage: {
    events: number;
    modelCalls: number;
    containerMinutes: number;
    deploys: number;
    browserCalls: number;
    firecrawlCalls: number;
    artifactWrites: number;
    costMicros: number;
  };
  connections: Array<{
    provider: "github" | "linear";
    status: string;
    accountName: string | null;
    updatedAt: string | null;
  }>;
  queue: {
    configured: boolean;
    pendingApproximation: number;
  };
  projects: Array<{
    id: string;
    name: string;
    status: string;
    url: string | null;
    repoMappingStatus: string;
    repoConfidence: number;
    repoUrl: string | null;
    activeRuns: number;
    failedRuns: number;
  }>;
  recentRuns: Array<{
    id: string;
    objective: string;
    status: string;
    projectName: string | null;
    autonomyMode: string;
    agentProvider: string;
    approvalRequired: number;
    createdAt: string;
    lastError: string | null;
  }>;
  recentArtifacts: Array<{
    id: string;
    kind: string;
    url: string | null;
    r2Key: string | null;
    createdAt: string;
  }>;
  templates: Array<{
    id: string;
    kind: string;
    repo: string;
    description: string;
    status: string;
  }>;
};

type TaskResponse = {
  id: string;
  status: string;
  approvalRequired: boolean;
};

function getBannerFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get("signin_required")) {
    const provider = params.get("provider");
    return provider
      ? `Sign in to connect ${provider}.`
      : "Sign in to continue.";
  }
  const oauthError = params.get("oauth_error");
  if (oauthError) {
    const provider = params.get("provider") ?? "the provider";
    return `OAuth with ${provider} failed: ${decodeURIComponent(oauthError)}. Try again.`;
  }
  return null;
}

function SignInForm({ banner }: { banner: string | null }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const signIn = useMutation({
    mutationFn: () =>
      fetchJson<{ user: unknown }>("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });
  return (
    <main className="min-h-screen bg-[#f7f8fb] text-[#17181c]">
      <div className="mx-auto max-w-md px-5 py-12">
        <h1 className="mb-2 text-2xl font-semibold">dev.fly.pm</h1>
        <p className="mb-6 text-sm text-[#5b6472]">Sign in to continue.</p>
        {banner ? (
          <div className="mb-4 rounded-md border border-[#f1b8b8] bg-[#fff1f1] px-3 py-2 text-sm text-[#a12828]">
            {banner}
          </div>
        ) : null}
        <form
          className="grid gap-3 rounded-md border border-[#dfe3ea] bg-white p-4"
          onSubmit={(event) => {
            event.preventDefault();
            signIn.mutate();
          }}
        >
          <label className="grid gap-1 text-sm">
            <span className="text-[#5b6472]">Email</span>
            <input
              type="email"
              autoComplete="email"
              required
              className="h-10 rounded border border-[#c9d0da] bg-white px-3 text-sm outline-none focus:border-[#3267d6]"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span className="text-[#5b6472]">Password</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              className="h-10 rounded border border-[#c9d0da] bg-white px-3 text-sm outline-none focus:border-[#3267d6]"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {signIn.error ? (
            <p className="text-sm text-[#a12828]">{signIn.error.message}</p>
          ) : null}
          <Button disabled={signIn.isPending || email.length === 0 || password.length === 0}>
            {signIn.isPending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </div>
    </main>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const [objective, setObjective] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState("");

  const overviewQuery = useQuery({
    queryKey: ["overview"],
    queryFn: () => fetchJson<Overview>("/api/overview"),
  });

  const banner = getBannerFromUrl();

  // Login is via Cloudflare Access, so sign-out must clear the Access session,
  // not the unused better-auth one. Full-page navigate to the Worker's
  // /api/access-logout, which 302s to the Access logout endpoint.
  function signOut() {
    window.location.href = "/api/access-logout";
  }

  const taskMutation = useMutation({
    mutationFn: (payload: { objective: string; linearProjectId?: string }) =>
      fetchJson<TaskResponse>("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      setObjective("");
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });

  // Early return AFTER all hooks have run so hook order is stable across
  // authed vs unauthed renders. See react.dev/errors/300.
  if (overviewQuery.data && !overviewQuery.data.user) {
    return <SignInForm banner={banner} />;
  }

  const overview = overviewQuery.data;
  const projects = overview?.projects ?? [];
  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ?? projects[0];

  function submitTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    taskMutation.mutate({
      objective,
      linearProjectId:
        selectedProject && selectedProject.id !== "linear_pending" ? selectedProject.id : undefined,
    });
  }

  return (
    <main className="min-h-screen bg-[#f7f8fb] text-[#17181c]">
      <header className="border-b border-[#dfe3ea] bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div>
            <h1 className="text-2xl font-semibold">dev.fly.pm</h1>
            <p className="text-sm text-[#5b6472]">
              {overview?.user
                ? `${overview.user.flyUserSlug} · ${overview.user.authSource}`
                : "Checking session"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <ConnectionButton provider="github" />
            <ConnectionButton provider="linear" />
            <Button variant="secondary" onClick={() => void overviewQuery.refetch()}>
              Refresh
            </Button>
            {overview?.user ? (
              <Button variant="secondary" onClick={signOut}>
                Sign out
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      {banner ? (
        <div className="mx-auto max-w-7xl px-5 pt-4">
          <div className="rounded-md border border-[#f1b8b8] bg-[#fff1f1] px-3 py-2 text-sm text-[#a12828]">
            {banner}
          </div>
        </div>
      ) : null}

      <div className="mx-auto grid max-w-7xl gap-5 px-5 py-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="grid gap-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Usage events" value={overview?.usage.events ?? 0} />
            <Metric label="Model calls" value={overview?.usage.modelCalls ?? 0} />
            <Metric label="Container min" value={overview?.usage.containerMinutes ?? 0} />
            <Metric label="Deploys" value={overview?.usage.deploys ?? 0} />
          </div>

          <section className="rounded-md border border-[#dfe3ea] bg-white p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold">Goal Intake</h2>
              <span className="rounded bg-[#eef7f0] px-2 py-1 text-xs font-medium text-[#1f6b3a]">
                approval gated
              </span>
            </div>
            <form className="grid gap-3" onSubmit={submitTask}>
              <select
                className="h-10 rounded border border-[#c9d0da] bg-white px-3 text-sm"
                value={selectedProject?.id ?? ""}
                onChange={(event) => setSelectedProjectId(event.target.value)}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
              <textarea
                className="min-h-28 resize-y rounded border border-[#c9d0da] bg-white px-3 py-2 text-sm leading-6 outline-none focus:border-[#3267d6]"
                value={objective}
                onChange={(event) => setObjective(event.target.value)}
                placeholder="Ship the next verified iteration for this Linear project"
              />
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-[#5b6472]">
                  {taskMutation.data
                    ? `${taskMutation.data.id} · ${taskMutation.data.status}`
                    : taskMutation.error
                      ? taskMutation.error.message
                      : "Manual approval required before sandbox execution"}
                </span>
                <Button disabled={objective.trim().length < 4 || taskMutation.isPending}>
                  Queue task
                </Button>
              </div>
            </form>
          </section>

          <section className="rounded-md border border-[#dfe3ea] bg-white">
            <div className="border-b border-[#e7eaf0] px-4 py-3">
              <h2 className="text-base font-semibold">Linear Projects</h2>
            </div>
            <div className="divide-y divide-[#e7eaf0]">
              {projects.map((project) => (
                <ProjectRow key={project.id} project={project} />
              ))}
            </div>
          </section>

          <section className="rounded-md border border-[#dfe3ea] bg-white">
            <div className="border-b border-[#e7eaf0] px-4 py-3">
              <h2 className="text-base font-semibold">Recent Runs</h2>
            </div>
            <div className="divide-y divide-[#e7eaf0]">
              {(overview?.recentRuns ?? []).length > 0 ? (
                overview!.recentRuns.map((run) => <RunRow key={run.id} run={run} />)
              ) : (
                <EmptyRow label="No runs queued" />
              )}
            </div>
          </section>
        </section>

        <aside className="grid content-start gap-5">
          <section className="rounded-md border border-[#dfe3ea] bg-white">
            <div className="border-b border-[#e7eaf0] px-4 py-3">
              <h2 className="text-base font-semibold">Connections</h2>
            </div>
            <div className="divide-y divide-[#e7eaf0]">
              {(overview?.connections ?? []).map((connection) => (
                <div key={connection.provider} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <p className="text-sm font-medium capitalize">{connection.provider}</p>
                    <p className="text-xs text-[#5b6472]">{connection.accountName ?? "not connected"}</p>
                  </div>
                  <StatusBadge status={connection.status} />
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-md border border-[#dfe3ea] bg-white p-4">
            <h2 className="mb-3 text-base font-semibold">Queue</h2>
            <div className="grid grid-cols-2 gap-3">
              <Metric label="Configured" value={overview?.queue.configured ? "yes" : "no"} />
              <Metric label="Pending" value={overview?.queue.pendingApproximation ?? 0} />
            </div>
          </section>

          <section className="rounded-md border border-[#dfe3ea] bg-white">
            <div className="border-b border-[#e7eaf0] px-4 py-3">
              <h2 className="text-base font-semibold">Templates</h2>
            </div>
            <div className="divide-y divide-[#e7eaf0]">
              {(overview?.templates ?? []).map((template) => (
                <div key={template.id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium">{template.kind}</p>
                    <StatusBadge status={template.status} />
                  </div>
                  <a className="mt-1 block break-all text-xs text-[#3267d6]" href={`https://github.com/${template.repo}`}>
                    {template.repo}
                  </a>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-md border border-[#dfe3ea] bg-white">
            <div className="border-b border-[#e7eaf0] px-4 py-3">
              <h2 className="text-base font-semibold">Artifacts</h2>
            </div>
            <div className="divide-y divide-[#e7eaf0]">
              {(overview?.recentArtifacts ?? []).length > 0 ? (
                overview!.recentArtifacts.map((artifact) => (
                  <div key={artifact.id} className="px-4 py-3 text-sm">
                    <p className="font-medium">{artifact.kind}</p>
                    <p className="break-all text-xs text-[#5b6472]">{artifact.url ?? artifact.r2Key}</p>
                  </div>
                ))
              ) : (
                <EmptyRow label="No artifacts written" />
              )}
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}

function ConnectionButton({ provider }: { provider: "github" | "linear" }) {
  return (
    <Button
      variant="secondary"
      onClick={() => {
        window.location.href = `/api/integrations/${provider}/connect`;
      }}
    >
      Connect {provider}
    </Button>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-[#dfe3ea] bg-white p-3">
      <p className="text-xs font-medium uppercase text-[#6a7382]">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </div>
  );
}

function ProjectRow({ project }: { project: Overview["projects"][number] }) {
  return (
    <div className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_190px_120px] md:items-center">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{project.name}</p>
        <p className="truncate text-xs text-[#5b6472]">{project.repoUrl ?? project.url ?? "repository pending"}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <StatusBadge status={project.status} />
        <StatusBadge status={project.repoMappingStatus} />
      </div>
      <p className="text-sm text-[#5b6472]">
        {project.activeRuns} active · {project.failedRuns} failed
      </p>
    </div>
  );
}

function RunRow({ run }: { run: Overview["recentRuns"][number] }) {
  return (
    <div className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_170px_110px] md:items-center">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{run.objective}</p>
        <p className="truncate text-xs text-[#5b6472]">{run.projectName ?? run.id}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <StatusBadge status={run.status} />
        <StatusBadge status={run.agentProvider} />
      </div>
      <p className="text-sm text-[#5b6472]">{run.approvalRequired ? "approval" : "queued"}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const normalized = status.replaceAll("_", " ");
  const tone =
    status.includes("failed") || status.includes("error")
      ? "border-[#f1b8b8] bg-[#fff1f1] text-[#a12828]"
      : status === "connected" || status === "active" || status === "mapped"
        ? "border-[#b9dcc5] bg-[#eef8f1] text-[#1f6b3a]"
        : "border-[#ccd6ea] bg-[#f1f5fb] text-[#31507d]";
  return (
    <span className={`rounded border px-2 py-1 text-xs font-medium ${tone}`}>
      {normalized}
    </span>
  );
}

function EmptyRow({ label }: { label: string }) {
  return <div className="px-4 py-6 text-sm text-[#6a7382]">{label}</div>;
}
