#!/bin/sh
set -eu

persist_dir="${PHARMAFLOW_PERSIST_DIR:-/app/persist}"
persist_data="$persist_dir/data"
persist_home="$persist_dir/home"

mkdir -p "$persist_data" "$persist_home/.config"

# A Railway volume starts empty and hides anything at its mount point. Seed
# only missing files so redeploys preserve cases, orders, and notifications.
for seed_file in /app/seed-data/*; do
  target_file="$persist_data/$(basename "$seed_file")"
  if [ ! -e "$target_file" ]; then
    cp -R "$seed_file" "$target_file"
  fi
done

rm -rf /app/data
ln -s "$persist_data" /app/data

export HOME="$persist_home"
export XDG_CONFIG_HOME="$persist_home/.config"
export TRUEFORGE_URL="${TRUEFORGE_URL:-http://127.0.0.1:8790}"
export PHARMAFLOW_MCP_URL="${PHARMAFLOW_MCP_URL:-http://127.0.0.1:8791/mcp}"
export PHARMAFLOW_FDA_MCP_URL="${PHARMAFLOW_FDA_MCP_URL:-http://127.0.0.1:8792/mcp}"

cleanup() {
  kill "${backend_pid:-}" "${trueforge_pid:-}" "${mcp_pid:-}" "${fda_pid:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

node src/mcp-server.mjs &
mcp_pid=$!
node src/fda-mcp-server.mjs &
fda_pid=$!
./node_modules/.bin/trueforge &
trueforge_pid=$!

node --input-type=module <<'EOF'
const deadline = Date.now() + 120_000;
const targets = [
  "http://127.0.0.1:8790/api/v1/agents",
  "http://127.0.0.1:8791/mcp",
  "http://127.0.0.1:8792/mcp",
];

while (Date.now() < deadline) {
  const ready = await Promise.all(
    targets.map(async (url) => {
      try {
        const response = await fetch(url);
        return response.status < 500;
      } catch {
        return false;
      }
    }),
  );
  if (ready.every(Boolean)) process.exit(0);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

console.error("Timed out waiting for TrueForge and MCP services.");
process.exit(1);
EOF

npm run setup

# Railway provides PORT for the single public dashboard endpoint. Keep the
# shell as PID 1 so its signal trap can stop every child cleanly.
node src/backend.mjs &
backend_pid=$!
wait "$backend_pid"
