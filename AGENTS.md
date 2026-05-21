# Remote Code — Agent Guide

## Project Overview

Remote Code is an OpenCode plugin that lets AI agents operate on remote machines over SSH, with zero footprint on the remote side. The remote machine only needs an SSH daemon; no agent, runtime, or dependency installation is required.

## Design Decisions

### SSH Argument Passing

Remote mode is activated **exclusively via environment variables**. The plugin reads `REMOTE_SSH`, `REMOTE_WORKDIR`, `REMOTE_PASSWORD`, and `REMOTE_SUDO_PASSWORD` from `process.env` at load time.

`REMOTE_SSH` accepts a **single SSH command string** exactly as a user would type in their terminal:

```bash
export REMOTE_SSH='ssh -oHostKeyAlgorithms=+ssh-rsa -i ~/.ssh/id_rsa user@host'
export REMOTE_WORKDIR='/home/project'
```

This gives users unlimited flexibility: any SSH option (`-o`, `-i`, `-p`, `-J` for jump hosts, `-v`, etc.) works without the plugin needing to know about it.

From this string we parse:

- `-o Key=Value` → extra SSH options
- `-i path` → identity file
- `-p port` → port (default 22)
- `user@host` → credentials and target

> **Note**: OpenCode's CLI does not recognize `--remote*` flags. Do not pass them on the command line — use a launcher script (`.bat`, `.ps1`, or `.sh`) that sets the environment variables before calling `opencode`.

### Session Persistence & Stable Working Directory

OpenCode's core ties sessions to the local working directory (`process.cwd()`). If you launch OpenCode from different local folders, your remote sessions appear to "disappear" because OpenCode filters sessions by the current directory.

To fix this, Remote Code implements **two complementary strategies**:

#### Strategy A: Launcher Scripts (always works)

Use the provided launcher scripts to always start OpenCode from a **stable local directory** derived from your remote target:

```bash
# Linux / macOS
chmod +x launchers/remote-opencode.sh
./launchers/remote-opencode.sh

# Windows PowerShell
.\launchers\remote-opencode.ps1

# Windows CMD
launchers\remote-opencode.bat
```

The launcher derives a unique local session directory from the remote host + remote workdir:

```
~/.opencode/remote-sessions/<host>_<remote_dir_slug>/
```

This ensures:
- Sessions are always bound to the same stable local path, regardless of where you invoke the launcher.
- Different remote machines / directories get isolated session directories automatically.
- No changes to OpenCode core or plugin code are required.

**Optional environment variables in launchers:**

| Variable | Description | Default |
|----------|-------------|---------|
| `REMOTE_POOL_COMMAND_SIZE` | SSH exec connection pool size | `3` |
| `REMOTE_POOL_FILE_SIZE` | SFTP connection pool size | `2` |
| `REMOTE_POOL_STAGGER_MS` | Delay between sequential SSH handshakes | `0` |


### Tool Strategy: Full Override via Plugin Tools

All seven tools (`bash`, `glob`, `grep`, `read`, `write`, `edit`, `apply_patch`) are implemented as **plugin tools that override built-in tools by name**.

Why full overrides instead of hooks for file operations:

- Plugin tool `execute` functions run outside OpenCode’s Effect system. They **cannot access internal services** (`LSP.Service`, `AppFileSystem.Service`, `Bus.Service`).
- This is actually desirable: file-editing plugin tools naturally avoid LSP diagnostics and file-watcher events that would otherwise fire against an incomplete local mirror and leak confusing output to the AI.
- `bash`/`glob`/`grep` must be fully rewritten anyway because their core execution logic (local shell / ripgrep) cannot be repurposed through hooks.
- For `read`/`write`/`edit`/`patch`, we rewrite them to operate on the local mirror and wrap each call with `pull` / `push` SFTP operations.

### Local Mirror + On-Demand Sync

Only files the AI actually touches are synchronized. The mirror lives at:

```
~/.opencode/mirrors/<host_slug>/<remote_root_slug>/
```

- A `manifest.json` tracks which remote files have local copies.
- `SyncEngine.pullAll()` rsyncs the manifest’s files from remote to local before a read/edit.
- `SyncEngine.pushAll()` rsyncs them back after a write/edit/patch.
- We do not track "dirtiness"; we call rsync unconditionally and let its delta algorithm decide what to transfer.

### Path Mapping

All paths visible to the AI are **remote absolute paths**. The plugin translates them to local mirror paths transparently:

```
Remote:  /home/project/src/main.ts
Local:   ~/.opencode/mirrors/root_192.168.1.3/home_project/home/project/src/main.ts
```

`PathMapper` provides:

- `toLocal(remotePath)` → local mirror path
- `toRemote(localPath)` → remote path
- `isWithinWorkspace(remotePath)` → security boundary check

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  OpenCode Agent Engine + TUI Renderer                       │
│  (unchanged)                                                │
└────────┬────────────────────────┬───────────────────────────┘
         │ calls tools by name    │ loads TUI slots
         ▼                        ▼
┌──────────────────────┐  ┌─────────────────────────────────┐
│  Server Plugin       │  │  TUI Plugin                     │
│  (dist/index.js)     │  │  (dist/tui.jsx)                 │
│                      │  │                                 │
│  ┌─────────────┐     │  │  ┌───────────────────────────┐  │
│  │ Tool Overrides│    │  │  │ session_prompt_right      │  │
│  │ (bash/glob/  │     │  │  │ home_prompt_right         │  │
│  │  grep/read/  │     │  │  │ → "🌐 Remote: host /path" │  │
│  │  write/edit/ │     │  │  └───────────────────────────┘  │
│  │  patch)      │     │  └─────────────────────────────────┘
│  └──────┬───────┘     │
│         │             │
│         ▼             │
│  ┌─────────────────┐  │
│  │  PathMapper     │  │
│  │  SyncEngine     │  │
│  │  SSHPool        │  │
│  └─────────────────┘  │
└───────────┬───────────┘
            │
            ▼
┌──────────────────────────────────────────────┐
│  Local Mirror FS                             │
│  (read/write/edit/patch operate here)        │
└──────────────────────────────────────────────┘
         │
    SFTP over ssh2 persistent connections
         │
         ▼
┌──────────────────────────────────────────────┐
│  Remote Machine (sshd only)                  │
└──────────────────────────────────────────────┘
```

## Key Implementation Details

### SSH Connection Pools

The plugin uses the pure-Node.js `ssh2` library to maintain persistent SSH connections:

- **Command pool** (3 connections, configurable via `REMOTE_POOL_COMMAND_SIZE`): for `bash`, `glob`, `grep` execution via `exec()`
- **File pool** (2 connections, configurable via `REMOTE_POOL_FILE_SIZE`): for SFTP file transfers via `sftp()`
- Pool sizes are deliberately conservative for legacy SSH servers (e.g. OpenSSH 5.3) that struggle with concurrent handshakes.

No external `ssh`, `sshpass`, or `rsync` binaries are required. Password authentication is handled natively by `ssh2`.

### Tool Behaviors

| Tool            | Strategy                                                                                                                                                                                                                      | Sync Trigger                                 |
| :-------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------- |
| `bash`        | SSH exec; stdout/stderr separated; SSH noise filtered; non-zero exit throws. Falls back to stderr heuristics when the remote shell reports an error but the exit code channel is not usable (rare, depends on ssh2 behavior). | none                                         |
| `glob`        | SSH `rg --files --sortr=modified` (fallback: `find + stat + sort`)                                                                                                                                                        | none                                         |
| `grep`        | SSH `rg --json` (fallback: `grep -rn`)                                                                                                                                                                                    | none                                         |
| `read`        | Read local mirror; binary detection; BOM preserved                                                                                                                                                                            | `pullAll()` before read                    |
| `write`       | Write local mirror; BOM preserved; unified diff preview in permission request                                                                                                                                                 | `pullAll()` if exists, `pushAll()` after |
| `edit`        | Edit local mirror; 9 fallback replacers (full OpenCode native set); per-file lock; BOM preserved; unified diff preview                                                                                                        | `pullAll()` before, `pushAll()` after    |
| `apply_patch` | Apply unified diff OR native OpenCode patch to local mirror; BOM preserved                                                                                                                                                    | `pullAll()` before, `pushAll()` after    |

### Concurrency

- `SyncEngine` uses a per-mirror mutex so only one SFTP operation runs at a time.
- `edit` tool uses per-file promise locks so concurrent edits on the same file are serialized.
- `SSHPool` queues SSH exec commands when all connections in the pool are busy.

### Security

- `PathMapper.isWithinWorkspace()` prevents `../` escapes before any filesystem or SSH operation.
- `bash` tool arguments are passed directly to SSH without intermediate shell parsing when possible; if shell features are needed, we rely on the remote shell and escape user-controlled strings.
- Remote file operations are bounded by the SSH user’s permissions; no privilege escalation.

## Technology Stack

- **Runtime**: Node.js / Bun (OpenCode runs on Bun; plugin uses standard `fs`, `child_process`)
- **SSH**: `ssh2` (pure Node.js SSH library; bundled)
- **Sync**: SFTP via `ssh2` (no external `rsync` required)
- **Language**: TypeScript
- **Schema**: Zod (matches `@opencode-ai/plugin` conventions)
- **TUI Framework**: SolidJS via `@opentui/solid` (peer dependency; OpenCode provides at runtime)
- **JSX**: Preserved (`"jsx": "preserve"` in tsconfig); OpenCode's bundler handles Solid JSX transform

## Open Questions / TODOs

1. **LSP for remote files**: Plugin tools cannot access OpenCode’s LSP service. Remote projects will not get LSP diagnostics. This is acceptable for the primary use case (legacy embedded systems) but may be revisited later via an LSP-over-SSH bridge.
2. ~~Directory reads via `read`~~ **(FIXED)**: `read` now lists directories over SSH (`ls -1pA`) so the full remote directory contents are visible, regardless of the local mirror state.
3. ~~Binary file handling~~ **(FIXED)**: `read` detects binary files by extension blacklist + content heuristic (null bytes or >30% non-printable chars in first 4KB).
4. **Mirror wipe on init**: To avoid stale files from previous sessions confusing the AI, `index.ts` wipes the local mirror base (`rm -rf`) and resets the manifest on every plugin load. This trades caching efficiency for correctness. A future enhancement could implement selective cleanup (remove only files not in the new manifest) or manifest snapshot/restore for rollback.
5. **Concurrent multi-session**: If two local OpenCode sessions target the same remote directory, their mirrors may conflict. The `edit` tool now has per-file locks to prevent concurrent edits on the same file within a single session. Cross-session conflicts still follow "last write wins" semantics.
6. ~~SSH password auth~~ **(FIXED)**: Password auth is supported natively by `ssh2`. Provide `REMOTE_PASSWORD` env var and `ssh2` will authenticate without `sshpass`.
7. **Windows remote targets**: The plugin is developed from a Windows host perspective. Remote Windows with OpenSSH should work for `bash` (PowerShell) but `glob`/`grep` may need remote `findstr` / `rg.exe` adjustments.

## Build & Install

### Prerequisites

- [Bun](https://bun.sh) or Node.js >= 20
- OpenCode >= 1.15.0

### Build

```bash
bun install
bun run build
```

### Install

```bash
# OpenCode plugins directory
cp -r dist/ ~/.config/opencode/plugins/remote-code
```

### Usage with Launcher

1. Copy `launchers/remote-opencode.sh` (or `.ps1`) to a location in your `$PATH`.
2. Edit the "User Configuration" block inside the launcher with your `REMOTE_SSH`, `REMOTE_WORKDIR`, and `REMOTE_PASSWORD`.
3. Run the launcher instead of `opencode` directly.

---

## Build & Install (Legacy)


```bash
# Local development
bun install
bun run build

# Install as OpenCode plugin
cp -r dist/ ~/.config/opencode/plugins/remote-code
```

## Testing

### Running Tests

Tests require a live SSH target. Credentials are **never hardcoded** — they are read from `.env.test` (gitignored) or environment variables.

```bash
# 1. Copy the example config
cp .env.test.example .env.test

# 2. Edit .env.test with your target
cat > .env.test << 'EOF'
REMOTE_SSH=ssh user@your-host
REMOTE_WORKDIR=/tmp/opencode-remote-test
REMOTE_PASSWORD=your-password
REMOTE_SUDO_PASSWORD=your-sudo-password
EOF

# 3. Run the test suites
npx tsx src/test-e2e.ts        # 34 tests — full tool coverage
npx tsx src/test-extended.ts   # 27 tests — strict assertions, BOM, diff, security
```

Both suites will fail early with a clear message if `REMOTE_SSH` is missing.

### What Each Suite Covers

| Suite                | Focus                                                                                                                                                                                                              |
| :------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test-e2e.ts`      | Connection pools, bash/glob/grep/read/write/edit/patch/sync/health — broad functional coverage                                                                                                                    |
| `test-extended.ts` | BOM preservation, unified diff format, strict content matching, patch move,`isWithinWorkspace` boundary security, `quoteShell` injection safety, read pagination, glob brace expansion, edit replacer fallback |

### Test Artifacts

Temporary files created during debugging (e.g. `tmp_test_*.js`) should be placed in `tmp_test_artifacts/` (already gitignored via `tmp_*`).
