# PharmaFlow — dashboard-only deploy image.
#
# Runs just the Express backend (src/backend.mjs), which serves the static
# dashboard UI and the REST API that reads/writes data/*.json directly.
# It does NOT start TrueForge or the MCP tool servers, so the "Open Agent"
# chat drawer is not functional in this deploy — everything else (patient
# panel, cases, recalls, supply data) works with no API keys required.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY web ./web
COPY data ./data

ENV NODE_ENV=production

# Render (and most free hosts) inject PORT; src/backend.mjs already reads
# process.env.PORT and falls back to 8787 for local runs.
EXPOSE 8787

CMD ["node", "src/backend.mjs"]
