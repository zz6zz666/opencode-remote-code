#!/usr/bin/env bash
# Launcher for OpenCode with Remote Code plugin
# This script ensures session persistence by anchoring OpenCode to a stable
# local directory derived from the remote target, regardless of where you
# invoke the launcher from.
#
# Usage:
#   1. Edit the "User Configuration" block below.
#   2. Make executable: chmod +x remote-opencode.sh
#   3. Run: ./remote-opencode.sh

set -e

# ==========================
# === User Configuration ===
# ==========================
REMOTE_SSH="ssh -oHostKeyAlgorithms=+ssh-rsa root@192.168.184.133"
REMOTE_WORKDIR="/home/work/TM018/TSMC018"
REMOTE_PASSWORD="123456"
REMOTE_SUDO_PASSWORD="123456"
# ==========================

# SSH connection pool tuning (uncomment to override defaults)
# REMOTE_POOL_COMMAND_SIZE=3
# REMOTE_POOL_FILE_SIZE=2
# REMOTE_POOL_STAGGER_MS=0

# Derive a stable local session directory from remote config.
# Format: ~/.opencode/remote-sessions/<host>_<remote_dir_slug>
HOST=$(echo "$REMOTE_SSH" | grep -oE '[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+' || echo "unknown")
HOST_ONLY=$(echo "$HOST" | cut -d'@' -f2)
DIR_SLUG=$(echo "$REMOTE_WORKDIR" | sed 's/^\///;s/\//_/g')
SESSION_DIR="$HOME/.opencode/remote-sessions/${HOST_ONLY}_${DIR_SLUG}"

mkdir -p "$SESSION_DIR"
cd "$SESSION_DIR"

export REMOTE_SSH
export REMOTE_WORKDIR
export REMOTE_PASSWORD
export REMOTE_SUDO_PASSWORD
# export REMOTE_POOL_COMMAND_SIZE
# export REMOTE_POOL_FILE_SIZE
# export REMOTE_POOL_STAGGER_MS

exec opencode "$@"
