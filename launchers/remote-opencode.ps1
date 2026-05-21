# Launcher for OpenCode with Remote Code plugin (PowerShell)
# This script ensures session persistence by anchoring OpenCode to a stable
# local directory derived from the remote target, regardless of where you
# invoke the launcher from.
#
# Usage:
#   1. Edit the "User Configuration" block below.
#   2. Run: .\remote-opencode.ps1

# ==========================
# === User Configuration ===
# ==========================
$REMOTE_SSH = "ssh -oHostKeyAlgorithms=+ssh-rsa root@192.168.184.133"
$REMOTE_WORKDIR = "/home/work/TM018/TSMC018"
$REMOTE_PASSWORD = "123456"
$REMOTE_SUDO_PASSWORD = "123456"
# ==========================

# SSH connection pool tuning (uncomment to override defaults)
# $env:REMOTE_POOL_COMMAND_SIZE = 3
# $env:REMOTE_POOL_FILE_SIZE = 2
# $env:REMOTE_POOL_STAGGER_MS = 0

# Derive a stable local session directory from remote config.
# Format: ~/.opencode/remote-sessions/<host>_<remote_dir_slug>
$match = [regex]::Match($REMOTE_SSH, '([a-zA-Z0-9._-]+)@([a-zA-Z0-9._-]+)')
if ($match.Success) {
    $hostOnly = $match.Groups[2].Value
} else {
    $hostOnly = "unknown"
}
$dirSlug = $REMOTE_WORKDIR.TrimStart('/') -replace '/', '_'
$sessionDir = Join-Path $env:USERPROFILE ".opencode/remote-sessions/${hostOnly}_${dirSlug}"

New-Item -ItemType Directory -Force -Path $sessionDir | Out-Null
Set-Location $sessionDir

$env:REMOTE_SSH = $REMOTE_SSH
$env:REMOTE_WORKDIR = $REMOTE_WORKDIR
$env:REMOTE_PASSWORD = $REMOTE_PASSWORD
$env:REMOTE_SUDO_PASSWORD = $REMOTE_SUDO_PASSWORD

& opencode @args
