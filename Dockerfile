FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN cp -R data /app/seed-data \
  && chmod +x /app/scripts/start-railway.sh

ENV NODE_ENV=production \
    TRUEFORGE_URL=http://127.0.0.1:8790 \
    PHARMAFLOW_MCP_URL=http://127.0.0.1:8791/mcp \
    PHARMAFLOW_FDA_MCP_URL=http://127.0.0.1:8792/mcp \
    MCP_PORT=8791 \
    FDA_MCP_PORT=8792 \
    PHARMAFLOW_PERSIST_DIR=/app/persist

EXPOSE 8787

CMD ["/app/scripts/start-railway.sh"]
