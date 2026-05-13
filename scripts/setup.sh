#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ "$#" -eq 0 ]; then
  exec bun "$ROOT_DIR/cli.ts" setup both
fi

case "$1" in
  claude|codex|both)
    exec bun "$ROOT_DIR/cli.ts" setup "$@"
    ;;
  *)
    exec bun "$ROOT_DIR/cli.ts" setup both "$@"
    ;;
esac
