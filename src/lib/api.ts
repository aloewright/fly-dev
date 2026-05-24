/* AGPL-3.0-or-later */
export async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") &&
    !headers.has("x-fly-user")
  ) {
    headers.set("x-fly-user", "local-dev");
  }

  const response = await fetch(input, { ...init, headers });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  return (await response.json()) as T;
}
