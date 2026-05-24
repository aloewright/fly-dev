/* AGPL-3.0-or-later */
import http from "node:http";

const port = Number(process.env.PORT ?? 8080);

const server = http.createServer(async (request, response) => {
  if (request.url === "/ready") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, runtime: "fly-dev-sandbox" }));
    return;
  }

  if (request.method === "POST" && request.url === "/run") {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    response.writeHead(202, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        accepted: true,
        receivedBytes: Buffer.byteLength(body),
        supportedAgents: ["codex", "claude-code"],
      }),
    );
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, "0.0.0.0");
