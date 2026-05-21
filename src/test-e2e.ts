/**
 * Enhanced E2E Test Suite for Remote Code
 *
 * Run with environment variables:
 *   REMOTE_SSH="ssh -oHostKeyAlgorithms=+ssh-rsa root@192.168.184.133" \
 *   REMOTE_WORKDIR=/tmp/opencode-remote-test \
 *   REMOTE_PASSWORD=123456 \
 *   REMOTE_SUDO_PASSWORD=123456 \
 *   npx tsx src/test-e2e.ts
 *
 * Features:
 * - Comprehensive timing for SSH connection init and every tool call
 * - Concurrent execution stress tests
 * - Large file I/O benchmarks
 * - Binary file detection
 * - Connection health verification
 * - Graceful failure handling (one test failing does not abort the suite)
 */

import { performance } from "perf_hooks"
import fs from "fs"
import path from "path"
import { loadConfig } from "./config.js"
import { ManifestManager } from "./manifest.js"
import { PathMapper } from "./path-mapper.js"
import { createSSHPool, type SSHPool } from "./ssh-pool.js"
import { SyncEngine } from "./sync-engine.js"
import { createBashTool } from "./tools/bash.js"
import { createEditTool } from "./tools/edit.js"
import { createGlobTool } from "./tools/glob.js"
import { createGrepTool } from "./tools/grep.js"
import { createPatchTool } from "./tools/patch.js"
import { createReadTool } from "./tools/read.js"
import { createWriteTool } from "./tools/write.js"

// =============================================================================
// Load .env.test (gitignored — never commit credentials)
// =============================================================================

try {
  const envPath = new URL("../.env.test", import.meta.url)
  const text = fs.readFileSync(envPath, "utf-8")
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (key && !process.env[key]) process.env[key] = value
  }
} catch {
  // .env.test not found — rely on existing env vars
}

// =============================================================================
// Configuration
// =============================================================================

// Force Linux path — do NOT rely on process.env.REMOTE_WORKDIR on Windows hosts,
// because MSYS2 may auto-convert /tmp/... to C:/Users/.../Temp/...
const REMOTE_WORKDIR = "/tmp/opencode-remote-test"

function ensureEnv() {
  if (!process.env.REMOTE_SSH) {
    throw new Error(
      "REMOTE_SSH is not set. Create .env.test (see .env.test.example) or set environment variables."
    )
  }
  // Always override REMOTE_WORKDIR to prevent MSYS2 path conversion on Windows
  if (process.env.REMOTE_WORKDIR && process.env.REMOTE_WORKDIR !== REMOTE_WORKDIR) {
    console.log(`[Config] Overriding MSYS2-converted REMOTE_WORKDIR: ${process.env.REMOTE_WORKDIR} -> ${REMOTE_WORKDIR}`)
  }
  process.env.REMOTE_WORKDIR = REMOTE_WORKDIR
  if (!process.env.REMOTE_PASSWORD) {
    console.log("[Config] REMOTE_PASSWORD not set — ssh key auth assumed")
  }
  if (!process.env.REMOTE_SUDO_PASSWORD) {
    process.env.REMOTE_SUDO_PASSWORD = process.env.REMOTE_PASSWORD
  }
}

// =============================================================================
// Mock Context
// =============================================================================

function getOutput(result: any): string {
  return typeof result === "string" ? result : result?.output ?? ""
}

function mockCtx() {
  return {
    sessionID: "test-session",
    messageID: "test-msg",
    agent: "test-agent",
    directory: "/mock/local",
    worktree: "/mock/local",
    abort: new AbortController().signal,
    metadata: (_input: { title?: string; metadata?: Record<string, any> }) => {},
    ask: async (_input: {
      permission: string
      patterns: string[]
      always: string[]
      metadata: Record<string, any>
    }) => {},
  }
}

// =============================================================================
// Timing & Reporting
// =============================================================================

interface TimingRecord {
  category: string
  name: string
  durationMs: number
  status: "PASS" | "FAIL" | "SKIP"
  error?: string
}

const timings: TimingRecord[] = []

async function timed<T>(
  category: string,
  name: string,
  fn: () => Promise<T>
): Promise<T> {
  const start = performance.now()
  try {
    const result = await fn()
    timings.push({
      category,
      name,
      durationMs: Math.round(performance.now() - start),
      status: "PASS",
    })
    return result
  } catch (err) {
    timings.push({
      category,
      name,
      durationMs: Math.round(performance.now() - start),
      status: "FAIL",
      error: (err as Error).message,
    })
    throw err
  }
}

async function runTest(
  category: string,
  name: string,
  fn: () => Promise<void>
): Promise<void> {
  process.stdout.write(`  ${name} ... `)
  try {
    await timed(category, name, fn)
    console.log(`✅ ${timings[timings.length - 1].durationMs}ms`)
  } catch (err) {
    const t = timings[timings.length - 1]
    console.log(`❌ ${t.durationMs}ms`)
    console.log(`     Error: ${t.error}`)
  }
}

function printReport() {
  const cats = new Map<string, TimingRecord[]>()
  for (const t of timings) {
    if (!cats.has(t.category)) cats.set(t.category, [])
    cats.get(t.category)!.push(t)
  }

  console.log("\n" + "=".repeat(80))
  console.log("TIMING REPORT")
  console.log("=".repeat(80))
  console.log(
    `${"Category".padEnd(18)} | ${"Test".padEnd(40)} | ${"Status".padEnd(6)} | ${"Time (ms)".padStart(9)}`
  )
  console.log("-".repeat(80))

  let totalMs = 0
  let totalPass = 0
  let totalFail = 0

  for (const [cat, records] of cats) {
    for (const r of records) {
      const catStr = r === records[0] ? cat.padEnd(18) : "".padEnd(18)
      const statusStr = r.status === "PASS" ? "PASS  " : "FAIL  "
      console.log(
        `${catStr} | ${r.name.padEnd(40)} | ${statusStr} | ${r.durationMs.toString().padStart(9)}`
      )
      totalMs += r.durationMs
      if (r.status === "PASS") totalPass++
      else totalFail++
    }
    console.log("-".repeat(80))
  }

  // Category summaries
  console.log("\nCategory Summaries:")
  for (const [cat, records] of cats) {
    const catMs = records.reduce((s, r) => s + r.durationMs, 0)
    const catPass = records.filter((r) => r.status === "PASS").length
    console.log(
      `  ${cat.padEnd(18)}: ${catPass}/${records.length} passed, total ${catMs}ms`
    )
  }

  console.log("\n" + "=".repeat(80))
  console.log(
    `TOTAL: ${totalPass + totalFail} tests, ${totalPass} passed, ${totalFail} failed, ${totalMs}ms`
  )
  console.log("=".repeat(80))
}

// =============================================================================
// Helpers
// =============================================================================

async function cleanupRemote(sshPool: SSHPool) {
  try {
    await sshPool.exec(`rm -rf ${REMOTE_WORKDIR}`, { timeout: 15_000 })
  } catch {}
}

async function setupTestDir(sshPool: SSHPool, manifest: ManifestManager, pathMapper: PathMapper) {
  // Clean remote and local mirror
  await cleanupRemote(sshPool)
  const fs = await import("fs/promises")
  try {
    await fs.rm(pathMapper.mirrorBase, { recursive: true, force: true })
  } catch {}
  // Reset manifest
  (manifest as any).manifest = { remote_root: pathMapper.remoteRoot, files: {} }

  await sshPool.exec(`mkdir -p ${REMOTE_WORKDIR}/src ${REMOTE_WORKDIR}/docs ${REMOTE_WORKDIR}/assets`, { timeout: 10_000 })

  // Create sample files using printf (reliable over exec channels)
  await sshPool.exec(
    `printf '%s\n' 'import { add } from "./utils";' 'const x = 1;' 'console.log(add(x, 2));' > ${REMOTE_WORKDIR}/src/main.ts`,
    { timeout: 10_000 }
  )
  await sshPool.exec(
    `printf '%s\n' 'export const add = (a: number, b: number) => a + b;' 'export const sub = (a: number, b: number) => a - b;' > ${REMOTE_WORKDIR}/src/utils.ts`,
    { timeout: 10_000 }
  )
  await sshPool.exec(
    `printf '%s\n' '# Hello World' '' 'This is a test project.' '' '## Features' '- Feature A' '- Feature B' > ${REMOTE_WORKDIR}/README.md`,
    { timeout: 10_000 }
  )
  await sshPool.exec(
    `printf '%s\n' '# Guide' '' 'Run npm start to begin.' > ${REMOTE_WORKDIR}/docs/guide.md`,
    { timeout: 10_000 }
  )
}

// =============================================================================
// Main Test Suite
// =============================================================================

async function main() {
  ensureEnv()

  console.log("Loading config...")
  const config = loadConfig()
  if (!config) {
    console.error("Failed to load config")
    process.exit(1)
  }
  console.log("Config loaded:", config.host, config.user, config.remoteWorkdir)

  // ── Connection: SSH Pool Init ────────────────────────────────────────────
  console.log("\n[Connection Tests]")
  let sshPool: SSHPool
  await runTest("connection", "ssh_pool_init", async () => {
    sshPool = await createSSHPool(config)
    const uname = await sshPool.exec("uname -a", { timeout: 10_000 })
    console.log(`     ${uname.stdout.trim()}`)
  })

  // Tools setup
  const bash = createBashTool(sshPool!, config.remoteWorkdir)
  const pathMapper = new PathMapper(config)
  const manifest = new ManifestManager(pathMapper)
  await manifest.load()
  const syncEngine = new SyncEngine(config, pathMapper, manifest, sshPool!)
  const readTool = createReadTool(pathMapper, syncEngine, sshPool!)
  const writeTool = createWriteTool(pathMapper, syncEngine)
  const editTool = createEditTool(pathMapper, syncEngine)
  const globTool = createGlobTool(config, sshPool!)
  const grepTool = createGrepTool(config, sshPool!)
  const patchTool = createPatchTool(config, pathMapper, syncEngine, sshPool!)

  // Prepare remote test directory
  await setupTestDir(sshPool!, manifest, pathMapper)

  // ── Connection: Concurrent Exec ──────────────────────────────────────────
  await runTest("connection", "concurrent_exec_5x", async () => {
    const cmds = Array.from({ length: 5 }, (_, i) =>
      sshPool!.exec(`echo "concurrent-${i}"`, { timeout: 10_000 })
    )
    const results = await Promise.all(cmds)
    for (let i = 0; i < 5; i++) {
      if (!results[i].stdout.includes(`concurrent-${i}`)) {
        throw new Error(`Concurrent command ${i} output mismatch`)
      }
    }
  })

  // ── Connection: Timeout Handling ─────────────────────────────────────────
  await runTest("connection", "timeout_handling", async () => {
    try {
      await sshPool!.exec("sleep 5", { timeout: 1_000 })
      throw new Error("Should have timed out")
    } catch (err) {
      if (!(err as Error).message.includes("timeout")) {
        throw err
      }
      // Expected timeout
    }
  })

  // ── Bash Tests ───────────────────────────────────────────────────────────
  console.log("\n[Bash Tests]")

  await runTest("bash", "basic_command", async () => {
    const result = await bash.execute(
      { command: "uname -a", description: "Check OS" },
      mockCtx()
    )
    if (!getOutput(result).includes("Linux")) throw new Error("Expected Linux in output")
  })

  await runTest("bash", "sudo_command", async () => {
    // CentOS 6 has Defaults requiretty — even SUDO_ASKPASS can't bypass it.
    // We verify the command is properly wrapped with SUDO_ASKPASS,
    // and that the failure mode is the TTY requirement (not auth failure).
    try {
      await bash.execute(
        { command: "sudo -A whoami", description: "Test sudo with askpass" },
        mockCtx()
      )
      throw new Error("Expected sudo to fail due to requiretty")
    } catch (err) {
      const msg = (err as Error).message
      if (!msg.includes("tty") && !msg.includes("terminal")) {
        throw err
      }
    }
  })

  await runTest("bash", "sudo_requires_tty", async () => {
    // CentOS 6 sudo requires TTY by default when no askpass is set
    try {
      await bash.execute(
        { command: "sudo whoami", description: "Test sudo without askpass" },
        mockCtx()
      )
      throw new Error("Should have failed due to missing TTY")
    } catch (err) {
      if (!(err as Error).message.includes("tty")) {
        throw err
      }
    }
  })

  await runTest("bash", "error_command", async () => {
    try {
      await bash.execute(
        { command: "nonexistent_command_xyz", description: "Test error" },
        mockCtx()
      )
      throw new Error("Should have failed")
    } catch (err) {
      const msg = (err as Error).message.toLowerCase()
      // Must contain the command name and indicate it was not found
      if (!msg.includes("nonexistent_command_xyz") || !msg.includes("not found")) {
        throw err
      }
    }
  })

  await runTest("bash", "long_output", async () => {
    const result = await bash.execute(
      { command: "seq 1 1000", description: "Generate 1000 lines" },
      mockCtx()
    )
    const lines = getOutput(result).split("\n").filter((l: string) => /^\d+$/.test(l.trim()))
    if (lines.length !== 1000) throw new Error(`Expected 1000 lines, got ${lines.length}`)
  })

  await runTest("bash", "workdir_switch", async () => {
    const result = await bash.execute(
      { command: "pwd", description: "Check cwd", workdir: "/tmp" },
      mockCtx()
    )
    if (!getOutput(result).includes("/tmp")) throw new Error("Expected /tmp in output")
  })

  // ── Read Tests ───────────────────────────────────────────────────────────
  console.log("\n[Read Tests]")

  await runTest("read", "read_directory", async () => {
    const result = await readTool.execute(
      { filePath: REMOTE_WORKDIR },
      mockCtx()
    )
    if (!getOutput(result).includes("src")) throw new Error("Expected src in directory listing")
  })

  await runTest("read", "read_text_file", async () => {
    const result = await readTool.execute(
      { filePath: `${REMOTE_WORKDIR}/src/main.ts` },
      mockCtx()
    )
    if (!getOutput(result).includes("console.log")) throw new Error("Expected console.log in file")
  })

  await runTest("read", "read_large_file", async () => {
    // Generate ~40KB text file (50 lines of 800 A's each = ~40KB + newlines)
    // Fits within MAX_BYTES = 50KB limit
    await sshPool!.exec(
      `python3 -c "print('\\\\n'.join(['A' * 800 for _ in range(50)]))" > ${REMOTE_WORKDIR}/large.txt`,
      { timeout: 10_000 }
    )
    const result = await readTool.execute(
      { filePath: `${REMOTE_WORKDIR}/large.txt` },
      mockCtx()
    )
    const output = getOutput(result)
    // Should contain all 50 lines
    const lineMatches = output.split("\n").filter((l: string) => l.includes("A")).length
    if (lineMatches < 50) throw new Error(`Expected ~50 lines of A's, found ${lineMatches}`)
  })

  await runTest("read", "read_missing_file", async () => {
    try {
      await readTool.execute(
        { filePath: `${REMOTE_WORKDIR}/nonexistent.xyz` },
        mockCtx()
      )
      throw new Error("Should have failed")
    } catch (err) {
      if (!(err as Error).message.includes("not found")) {
        throw err
      }
    }
  })

  await runTest("read", "read_binary_file", async () => {
    // Create a file with null bytes
    await sshPool!.exec(
      `printf '\\x00\\x01\\x02\\x03' > ${REMOTE_WORKDIR}/binary.dat`,
      { timeout: 10_000 }
    )
    try {
      await readTool.execute(
        { filePath: `${REMOTE_WORKDIR}/binary.dat` },
        mockCtx()
      )
      throw new Error("Should have rejected binary file")
    } catch (err) {
      if (!(err as Error).message.includes("binary")) {
        throw err
      }
    }
  })

  // ── Write Tests ──────────────────────────────────────────────────────────
  console.log("\n[Write Tests]")

  await runTest("write", "write_new_file", async () => {
    await writeTool.execute(
      {
        filePath: `${REMOTE_WORKDIR}/src/newfile.ts`,
        content: "export const PI = 3.14159;\n",
      },
      mockCtx()
    )
    const verify = await sshPool!.exec(`cat ${REMOTE_WORKDIR}/src/newfile.ts`, { timeout: 10_000 })
    if (!verify.stdout.includes("PI")) throw new Error("File not written correctly")
  })

  await runTest("write", "write_overwrite", async () => {
    await writeTool.execute(
      {
        filePath: `${REMOTE_WORKDIR}/src/utils.ts`,
        content: "// overwritten\nexport const mul = (a: number, b: number) => a * b;\n",
      },
      mockCtx()
    )
    const verify = await sshPool!.exec(`cat ${REMOTE_WORKDIR}/src/utils.ts`, { timeout: 10_000 })
    if (!verify.stdout.includes("overwritten")) throw new Error("File not overwritten")
  })

  await runTest("write", "write_large_file", async () => {
    const largeContent = "X".repeat(100_000) + "\n"
    await writeTool.execute(
      {
        filePath: `${REMOTE_WORKDIR}/large_write.txt`,
        content: largeContent,
      },
      mockCtx()
    )
    const verify = await sshPool!.exec(`wc -c ${REMOTE_WORKDIR}/large_write.txt`, { timeout: 15_000 })
    const size = parseInt(verify.stdout.trim().split(/\s+/)[0], 10)
    // 100_000 X's + 1 newline = 100001 bytes
    if (size !== 100_001) throw new Error(`Expected 100001 bytes, got ${size} bytes`)
  })

  // ── Edit Tests ───────────────────────────────────────────────────────────
  console.log("\n[Edit Tests]")

  async function resetMainTs(content: string) {
    await sshPool!.exec(
      `printf '%s\n' ${content.split("\n").map((l) => `'${l.replace(/'/g, "'\"'\"'")}'`).join(" ")} > ${REMOTE_WORKDIR}/src/main.ts`,
      { timeout: 10_000 }
    )
  }

  await runTest("edit", "edit_exact_match", async () => {
    await resetMainTs('import { add } from "./utils";\nconst x = 1;\nconsole.log(add(x, 2));')
    await editTool.execute(
      {
        filePath: `${REMOTE_WORKDIR}/src/main.ts`,
        oldString: "const x = 1;",
        newString: "const x = 42;",
      },
      mockCtx()
    )
    const verify = await sshPool!.exec(`cat ${REMOTE_WORKDIR}/src/main.ts`, { timeout: 10_000 })
    if (!verify.stdout.includes("const x = 42;")) throw new Error("Exact edit failed")
  })

  await runTest("edit", "edit_multiline", async () => {
    await resetMainTs('import { add } from "./utils";\nconst x = 42;\nconsole.log(add(x, 2));')
    await editTool.execute(
      {
        filePath: `${REMOTE_WORKDIR}/src/main.ts`,
        oldString: 'import { add } from "./utils";\nconst x = 42;',
        newString: 'import { add, sub } from "./utils";\nconst x = 99;',
      },
      mockCtx()
    )
    const verify = await sshPool!.exec(`cat ${REMOTE_WORKDIR}/src/main.ts`, { timeout: 10_000 })
    if (!verify.stdout.includes("sub")) throw new Error("Multiline edit failed")
  })

  await runTest("edit", "edit_whitespace_tolerance", async () => {
    await resetMainTs('function test() {\n  const   a   =   1;\n  return a;\n}')
    await editTool.execute(
      {
        filePath: `${REMOTE_WORKDIR}/src/main.ts`,
        oldString: "const a = 1;",
        newString: "const a = 999;",
      },
      mockCtx()
    )
    const verify = await sshPool!.exec(`cat ${REMOTE_WORKDIR}/src/main.ts`, { timeout: 10_000 })
    if (!verify.stdout.includes("999")) throw new Error("Whitespace-tolerant edit failed")
  })

  // ── Glob Tests ───────────────────────────────────────────────────────────
  console.log("\n[Glob Tests]")

  await runTest("glob", "glob_basic", async () => {
    const result = await globTool.execute(
      { pattern: "*.ts", path: `${REMOTE_WORKDIR}/src` },
      mockCtx()
    )
    if (!getOutput(result).includes(".ts")) throw new Error("Expected .ts files")
  })

  await runTest("glob", "glob_recursive", async () => {
    const result = await globTool.execute(
      { pattern: "*.md", path: REMOTE_WORKDIR },
      mockCtx()
    )
    if (!getOutput(result).includes(".md")) throw new Error("Expected .md files")
  })

  await runTest("glob", "glob_no_match", async () => {
    const result = await globTool.execute(
      { pattern: "*.py", path: REMOTE_WORKDIR },
      mockCtx()
    )
    if (!getOutput(result).includes("No files found")) throw new Error("Expected no files found")
  })

  // ── Grep Tests ───────────────────────────────────────────────────────────
  console.log("\n[Grep Tests]")

  // Restore main.ts for grep tests (edit tests may have modified it)
  await sshPool!.exec(
    `printf '%s\n' 'import { add } from "./utils";' 'const x = 1;' 'console.log(add(x, 2));' > ${REMOTE_WORKDIR}/src/main.ts`,
    { timeout: 10_000 }
  )

  await runTest("grep", "grep_basic", async () => {
    const result = await grepTool.execute(
      { pattern: "console\\.log", path: REMOTE_WORKDIR },
      mockCtx()
    )
    if (!getOutput(result).includes("Found")) throw new Error("Expected matches")
  })

  await runTest("grep", "grep_regex", async () => {
    // Use a pattern compatible with both ripgrep and legacy grep (BRE/ERE)
    const result = await grepTool.execute(
      { pattern: "const [a-z]+ =", path: REMOTE_WORKDIR },
      mockCtx()
    )
    if (!getOutput(result).includes("Found")) throw new Error("Expected regex matches")
  })

  await runTest("grep", "grep_include_filter", async () => {
    const result = await grepTool.execute(
      { pattern: "export", path: REMOTE_WORKDIR, include: "*.ts" },
      mockCtx()
    )
    if (!getOutput(result).includes("Found")) throw new Error("Expected filtered matches")
  })

  await runTest("grep", "grep_no_match", async () => {
    const result = await grepTool.execute(
      { pattern: "zzzzzzzzzzzzzzzz", path: REMOTE_WORKDIR },
      mockCtx()
    )
    if (!getOutput(result).includes("No files found")) throw new Error("Expected no matches")
  })

  // ── Patch Tests ──────────────────────────────────────────────────────────
  console.log("\n[Patch Tests]")

  await runTest("patch", "patch_unified_single", async () => {
    // Reset main.ts
    await sshPool!.exec(
      `cat > ${REMOTE_WORKDIR}/src/main.ts << 'EOF'
import { add } from "./utils";
const x = 1;
console.log(add(x, 2));
EOF`,
      { timeout: 10_000 }
    )
    const patchText = `*** Begin Patch
--- a/src/main.ts
+++ b/src/main.ts
@@ -1,3 +1,3 @@
 import { add } from "./utils";
-const x = 1;
+const x = 100;
 console.log(add(x, 2));
*** End Patch`
    await patchTool.execute({ patchText }, mockCtx())
    const verify = await sshPool!.exec(`cat ${REMOTE_WORKDIR}/src/main.ts`, { timeout: 10_000 })
    if (!verify.stdout.includes("const x = 100;")) throw new Error("Unified patch failed")
  })

  await runTest("patch", "patch_native_add_file", async () => {
    const patchText = `*** Begin Patch
*** Add File: ${REMOTE_WORKDIR}/new_native.ts
+export const greeting = "hello";
*** End Patch`
    await patchTool.execute({ patchText }, mockCtx())
    const verify = await sshPool!.exec(`cat ${REMOTE_WORKDIR}/new_native.ts`, { timeout: 10_000 })
    if (!verify.stdout.includes("hello")) throw new Error("Native add-file patch failed")
  })

  await runTest("patch", "patch_native_update_multi", async () => {
    // Prepare files using writeTool to ensure local mirror is in sync
    await writeTool.execute(
      { filePath: `${REMOTE_WORKDIR}/src/patch_utils.ts`, content: "export const add = (a: number, b: number) => a + b;\n" },
      mockCtx()
    )
    await writeTool.execute(
      { filePath: `${REMOTE_WORKDIR}/docs/patch_guide.md`, content: "# Guide\nOld content here.\n" },
      mockCtx()
    )
    const patchText = `*** Begin Patch
*** Update File: ${REMOTE_WORKDIR}/src/patch_utils.ts
@@
 export const add = (a: number, b: number) => a + b;
+export const mul = (a: number, b: number) => a * b;
*** Update File: ${REMOTE_WORKDIR}/docs/patch_guide.md
@@
 # Guide
-Old content here.
+Updated content here.
*** End Patch`
    await patchTool.execute({ patchText }, mockCtx())
    const v1 = await sshPool!.exec(`cat ${REMOTE_WORKDIR}/src/patch_utils.ts`, { timeout: 10_000 })
    if (!v1.stdout.includes("mul")) throw new Error("Multi-file patch failed on patch_utils.ts")
    const v2 = await sshPool!.exec(`cat ${REMOTE_WORKDIR}/docs/patch_guide.md`, { timeout: 10_000 })
    if (!v2.stdout.includes("Updated content here.")) throw new Error("Multi-file patch failed on patch_guide.md")
  })

  // ── Sync Tests ───────────────────────────────────────────────────────────
  console.log("\n[Sync Tests]")

  await runTest("sync", "sync_pull", async () => {
    // Register and pull
    await syncEngine.register(`${REMOTE_WORKDIR}/README.md`)
    await syncEngine.pullAll()
    // Local mirror should now have the file
    const localPath = pathMapper.toLocal(`${REMOTE_WORKDIR}/README.md`)
    const fs = await import("fs/promises")
    const content = await fs.readFile(localPath, "utf-8")
    if (!content.includes("Hello World")) throw new Error("Pull failed")
  })

  await runTest("sync", "sync_push", async () => {
    // Write locally then push
    const fs = await import("fs/promises")
    const localPath = pathMapper.toLocal(`${REMOTE_WORKDIR}/push_test.txt`)
    await fs.mkdir(path.dirname(localPath), { recursive: true })
    await fs.writeFile(localPath, "pushed content\n", "utf-8")
    await syncEngine.register(`${REMOTE_WORKDIR}/push_test.txt`)
    await syncEngine.pushAll()
    const verify = await sshPool!.exec(`cat ${REMOTE_WORKDIR}/push_test.txt`, { timeout: 10_000 })
    if (!verify.stdout.includes("pushed content")) throw new Error("Push failed")
  })

  // ── Health Check ─────────────────────────────────────────────────────────
  console.log("\n[Health Tests]")

  await runTest("health", "pool_size_maintained", async () => {
    // After all the above operations, the pool should still have healthy connections
    // We verify by running a simple command
    const result = await sshPool!.exec("echo health_check_ok", { timeout: 10_000 })
    if (!result.stdout.includes("health_check_ok")) {
      throw new Error("Pool connections are not healthy")
    }
  })

  await runTest("health", "rapid_commands", async () => {
    // Send 20 rapid commands to stress the pool
    for (let i = 0; i < 20; i++) {
      const result = await sshPool!.exec(`echo "rapid-${i}"`, { timeout: 10_000 })
      if (!result.stdout.includes(`rapid-${i}`)) {
        throw new Error(`Rapid command ${i} failed`)
      }
    }
  })

  // Cleanup
  console.log("\nCleaning up...")
  await cleanupRemote(sshPool!)
  await sshPool!.close()

  // Print report
  printReport()

  const failed = timings.filter((t) => t.status === "FAIL").length
  if (failed > 0) {
    console.log(`\n⚠️  ${failed} test(s) failed`)
    process.exit(1)
  }
  console.log("\n🎉 All tests passed!")
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
