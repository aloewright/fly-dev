FROM node:22-slim

ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /workspace

RUN npm install -g @openai/codex @anthropic-ai/claude-code

COPY server.mjs /app/server.mjs

EXPOSE 8080
CMD ["node", "/app/server.mjs"]
