@echo off
REM Launcher for OpenCode with Remote Code plugin (Windows CMD)
REM This script ensures session persistence by anchoring OpenCode to a stable
REM local directory derived from the remote target, regardless of where you
REM invoke the launcher from.
REM
REM Usage:
REM   1. Edit the "User Configuration" block below.
REM   2. Run: remote-opencode.bat

chcp 65001 >nul

REM ==========================
REM === User Configuration ===
REM ==========================
set "REMOTE_SSH=ssh -oHostKeyAlgorithms=+ssh-rsa root@192.168.184.133"
set "REMOTE_WORKDIR=/home/work/TM018/TSMC018"
set "REMOTE_PASSWORD=123456"
set "REMOTE_SUDO_PASSWORD=123456"
REM ==========================

REM SSH connection pool tuning (uncomment to override defaults)
REM set "REMOTE_POOL_COMMAND_SIZE=3"
REM set "REMOTE_POOL_FILE_SIZE=2"
REM set "REMOTE_POOL_STAGGER_MS=0"

REM Derive a stable local session directory from remote config.
REM Format: %USERPROFILE%\.opencode\remote-sessions\<host>_<remote_dir_slug>
for /f "tokens=2 delims=@" %%a in ("%REMOTE_SSH%") do set "HOST_ONLY=%%a"
if not defined HOST_ONLY set "HOST_ONLY=unknown"

set "DIR_SLUG=%REMOTE_WORKDIR:/=_%"
set "DIR_SLUG=%DIR_SLUG:~1%"
set "SESSION_DIR=%USERPROFILE%\.opencode\remote-sessions\%HOST_ONLY%_%DIR_SLUG%"

if not exist "%SESSION_DIR%" mkdir "%SESSION_DIR%"
cd /d "%SESSION_DIR%"

opencode %*
