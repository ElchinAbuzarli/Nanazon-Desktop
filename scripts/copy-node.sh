#!/bin/bash
# Copy the correct Node.js binary for the current platform/architecture
# This runs as part of the build process

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BUNDLED_DIR="$PROJECT_DIR/bundled-node"
TARGET_DIR="$PROJECT_DIR/scripts"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS" in
  darwin) PLATFORM="darwin" ;;
  linux)  PLATFORM="linux" ;;
  *)      PLATFORM="windows" ;;
esac

case "$ARCH" in
  arm64|aarch64) ARCH_DIR="arm64" ;;
  *)             ARCH_DIR="x64" ;;
esac

NODE_SRC="$BUNDLED_DIR/${PLATFORM}-${ARCH_DIR}/node"

if [ -f "$NODE_SRC" ]; then
  cp "$NODE_SRC" "$TARGET_DIR/node"
  chmod +x "$TARGET_DIR/node"
  echo "[copy-node] Copied node binary for ${PLATFORM}-${ARCH_DIR}"
else
  echo "[copy-node] WARNING: No bundled node binary found at $NODE_SRC"
  exit 1
fi
