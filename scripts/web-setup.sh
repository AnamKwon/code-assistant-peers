#!/usr/bin/env sh
set -eu

REPO_URL="${CODE_ASSISTANT_PEERS_REPO_URL:-https://github.com/AnamKwon/code-assistant-peers.git}"
INSTALL_DIR="${CODE_ASSISTANT_PEERS_DIR:-$HOME/mcp-code-assistant-peers}"
TARGET="codex"
TIMEOUT="1800"
SERENA="auto"
PEERS=""
RUN_INSTALL="1"

usage() {
  cat <<'EOF'
code-assistant-peers web setup

Usage:
  sh scripts/web-setup.sh [options]
  curl -fsSL https://raw.githubusercontent.com/AnamKwon/code-assistant-peers/main/scripts/web-setup.sh | sh -s -- [options]

Options:
  --dir PATH          Project directory. Default: ~/mcp-code-assistant-peers
  --target NAME       claude, codex, or both. Default: codex
  --peers LIST        Reviewer ids, or auto. Example: auto or claude,gemini
  --timeout SECONDS   Codex MCP tool timeout. Default: 1800
  --serena MODE       auto, on, or off. Default: auto
  --no-install        Skip bun install
  -h, --help          Show help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    --dir=*)
      INSTALL_DIR="${1#--dir=}"
      shift
      ;;
    --target)
      TARGET="$2"
      shift 2
      ;;
    --target=*)
      TARGET="${1#--target=}"
      shift
      ;;
    --peers)
      PEERS="$2"
      shift 2
      ;;
    --peers=*)
      PEERS="${1#--peers=}"
      shift
      ;;
    --timeout)
      TIMEOUT="$2"
      shift 2
      ;;
    --timeout=*)
      TIMEOUT="${1#--timeout=}"
      shift
      ;;
    --serena)
      SERENA="$2"
      shift 2
      ;;
    --serena=*)
      SERENA="${1#--serena=}"
      shift
      ;;
    --no-install)
      RUN_INSTALL="0"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

case "$TARGET" in
  claude|codex|both) ;;
  *)
    echo "--target must be claude, codex, or both" >&2
    exit 1
    ;;
esac

case "$SERENA" in
  auto|on|off) ;;
  *)
    echo "--serena must be auto, on, or off" >&2
    exit 1
    ;;
esac

case "$TIMEOUT" in
  ''|*[!0-9]*)
    echo "--timeout must be an integer number of seconds" >&2
    exit 1
    ;;
esac

if [ "$TIMEOUT" -lt 30 ]; then
  echo "--timeout must be >= 30" >&2
  exit 1
fi

need_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

need_command bun

if [ ! -f "$INSTALL_DIR/cli.ts" ]; then
  need_command git
  echo "Cloning code-assistant-peers into $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

if [ "$RUN_INSTALL" = "1" ]; then
  echo "Installing dependencies"
  bun install
fi

echo "Registering MCP server: target=$TARGET timeout=${TIMEOUT}s serena=$SERENA"
if [ -n "$PEERS" ]; then
  bun cli.ts setup "$TARGET" --timeout="$TIMEOUT" --serena="$SERENA" --peers="$PEERS"
else
  bun cli.ts setup "$TARGET" --timeout="$TIMEOUT" --serena="$SERENA"
fi

echo
echo "Running local diagnostics"
bun cli.ts doctor

echo
echo "Codex code-assistant-peers config"
CODEX_CONFIG="${HOME}/.codex/config.toml"
if [ -f "$CODEX_CONFIG" ]; then
  awk '
    /^\[mcp_servers\.code-assistant-peers(\.env)?\]$/ { inside = 1; print; next }
    inside && /^\[/ { inside = 0 }
    inside && /^(command|args|startup_timeout_sec|tool_timeout_sec) =/ { print }
    inside && /^(HOST_ASSISTANT|PEER_ASSISTANT|PEER_ASSISTANTS|CODE_ASSISTANT_PEERS_[A-Z0-9_]+) =/ { print }
  ' "$CODEX_CONFIG"
else
  echo "No Codex config found at $CODEX_CONFIG"
fi

echo
echo "Serena registration check"
if [ "$TARGET" = "codex" ] || [ "$TARGET" = "both" ]; then
  if [ -f "$CODEX_CONFIG" ] && grep -Eq 'CODE_ASSISTANT_PEERS_CONTEXT_PROVIDER[[:space:]]*=[[:space:]]*"serena-auto"' "$CODEX_CONFIG"; then
    echo "OK  Codex MCP env uses serena-auto"
  else
    echo "WARN Codex MCP env does not show serena-auto"
  fi
fi

if [ "$TARGET" = "claude" ] || [ "$TARGET" = "both" ]; then
  CLAUDE_CONFIG="${HOME}/.claude.json"
  if [ -f "$CLAUDE_CONFIG" ] && grep -q 'CODE_ASSISTANT_PEERS_CONTEXT_PROVIDER=serena-auto' "$CLAUDE_CONFIG"; then
    echo "OK  Claude MCP env uses serena-auto"
  else
    echo "WARN Claude MCP env does not show serena-auto"
  fi
fi

echo
echo "Done. Restart Claude Code/Codex, then call code_assistant_peers_setup from the MCP client."
