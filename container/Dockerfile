# AGPL-3.0-or-later
FROM node:22-slim

ENV NODE_ENV=production
ENV PORT=8080

# git + TLS roots are required to clone over HTTPS; node:22-slim ships neither.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Pin these in production for reproducible, supply-chain-reviewed builds
# (override with --build-arg). See SANDBOX_REVIEW.md (sandbox findings).
ARG CODEX_VERSION=latest
ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g "@openai/codex@${CODEX_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# Run the agent (which executes model-generated changes) as a non-root user.
RUN useradd --system --create-home --home-dir /home/sandbox sandbox \
  && mkdir -p /app \
  && chown -R sandbox:sandbox /app /home/sandbox

COPY --chown=sandbox:sandbox server.mjs /app/server.mjs

USER sandbox
WORKDIR /home/sandbox
ENV HOME=/home/sandbox

EXPOSE 8080
CMD ["node", "/app/server.mjs"]
