#!/usr/bin/env bash
set -euo pipefail

# NanoClaw one-shot service recovery script (macOS launchd)
# - Switch to project Node version from .nvmrc (if nvm is available)
# - Ensure sane timeout defaults in .env
# - Regenerate service plist
# - Hard reload launchd job
# - Print status and recent logs

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="$ROOT_DIR/.env"
PLIST_PATH="$HOME/Library/LaunchAgents/com.nanoclaw.plist"
SERVICE_ID="com.nanoclaw"
LAUNCHD_TARGET="gui/$(id -u)/$SERVICE_ID"

# You can override these when running the script:
#   IDLE_TIMEOUT_MS=300000 CONTAINER_TIMEOUT_MS=1800000 ./scripts/restart-nanoclaw.sh
IDLE_TIMEOUT_MS="${IDLE_TIMEOUT_MS:-300000}"
CONTAINER_TIMEOUT_MS="${CONTAINER_TIMEOUT_MS:-1800000}"
FORCE_NODE_BIN="${FORCE_NODE_BIN:-}"

upsert_env() {
  local key="$1"
  local value="$2"
  local file="$3"

  if [[ ! -f "$file" ]]; then
    printf '%s=%s\n' "$key" "$value" > "$file"
    return
  fi

  if grep -qE "^${key}=" "$file"; then
    perl -i -pe "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$file"
  fi
}

echo "[1/6] Enter project: $ROOT_DIR"

# Try to use nvm + .nvmrc (best-effort)
if [[ -f "$ROOT_DIR/.nvmrc" ]]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    # shellcheck source=/dev/null
    source "$NVM_DIR/nvm.sh"
    NODE_VERSION="$(tr -d '[:space:]' < "$ROOT_DIR/.nvmrc")"
    if [[ -n "$NODE_VERSION" ]]; then
      echo "[2/6] Switch Node via nvm: $NODE_VERSION"
      nvm install "$NODE_VERSION" >/dev/null
      nvm use "$NODE_VERSION" >/dev/null
      NVM_NODE_BIN="$(nvm which "$NODE_VERSION" 2>/dev/null || true)"
      if [[ -n "$NVM_NODE_BIN" && -x "$NVM_NODE_BIN" ]]; then
        export FORCE_NODE_BIN="$NVM_NODE_BIN"
      fi
    fi
  else
    echo "[2/6] nvm not found, skip Node switch"
  fi
else
  echo "[2/6] .nvmrc not found, skip Node switch"
fi

if [[ -n "$FORCE_NODE_BIN" && -x "$FORCE_NODE_BIN" ]]; then
  # Make sure every subsequent command resolves to the exact node binary.
  export PATH="$(dirname "$FORCE_NODE_BIN"):$PATH"
  hash -r
fi

echo "Node: $(node -v)"
echo "Node path: $(command -v node)"

echo "[3/6] Update .env timeouts"
upsert_env "IDLE_TIMEOUT" "$IDLE_TIMEOUT_MS" "$ENV_FILE"
upsert_env "CONTAINER_TIMEOUT" "$CONTAINER_TIMEOUT_MS" "$ENV_FILE"

echo "[4/6] Rebuild service config"
if [[ -n "$FORCE_NODE_BIN" && -x "$FORCE_NODE_BIN" ]]; then
  "$FORCE_NODE_BIN" ./node_modules/tsx/dist/cli.mjs setup/index.ts --step service
else
  npx tsx setup/index.ts --step service
fi

if [[ ! -f "$PLIST_PATH" ]]; then
  echo "ERROR: launchd plist not found: $PLIST_PATH"
  exit 1
fi

echo "[5/6] Hard reload launchd job: $LAUNCHD_TARGET"
launchctl bootout "$LAUNCHD_TARGET" 2>/dev/null || true
if ! launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null; then
  echo "bootstrap failed, fallback to unload+load"
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  launchctl load "$PLIST_PATH"
fi
launchctl kickstart -k "$LAUNCHD_TARGET"

echo "[6/6] Verify status + show recent logs"
launchctl print "$LAUNCHD_TARGET" 2>/dev/null | rg "state =|program =|pid =" || true
echo "----- logs/nanoclaw.log (last 60 lines) -----"
tail -n 60 "$ROOT_DIR/logs/nanoclaw.log" 2>/dev/null || true
echo "----- logs/nanoclaw.error.log (last 60 lines) -----"
tail -n 60 "$ROOT_DIR/logs/nanoclaw.error.log" 2>/dev/null || true

echo "Done."
echo "Tip: if the laptop sleeps, background tasks pause. During long tests you can run: caffeinate -dimsu"
