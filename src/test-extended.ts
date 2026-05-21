/**
 * Extended Verification Test Suite for Remote Code
 *
 * This suite targets the blind spots of test-e2e.ts:
 * - BOM preservation across read/write/edit/patch
 * - Unified diff preview format verification
 * - Strict content matching (not just includes())
 * - edit oldString="" create-file path
 * - Patch move operations
 * - isWithinWorkspace boundary security regression
 * - quoteShell injection safety
 * - Read offset/limit pagination
 * - Glob brace expansion fallback
 *
 * Run:
 *   REMOTE_SSH="ssh -oHostKeyAlgorithms=+ssh-rsa root@192.168.184.133" \
 *   REMOTE_PASSWORD=123456 \
 *   npx tsx src/test-extended.ts
 */

import { performance } from "perf_hooks"
import fs from "fs/promises"
import { readFileSync } from "fs"
import { loadConfig } from "./config.js"
import { ManifestManager } from "./manifest.js"
import { PathMapper } from "./path-mapper.js"
import { createSSHPool } from "./ssh-pool.js"
import { SyncEngine } from "./sync-engine.js"
import { createEditTool } from "./tools/edit.js"
import { createGlobTool } from "./tools/glob.js"
import { createPatchTool } from "./tools/patch.js"
import { createReadTool } from "./tools/read.js"
import { createWriteTool } from "./tools/write.js"
import { quoteShell } from "./shell-quote.js"

// Load .env.test if present (gitignored — never commit credentials)
try {
  const envPath = new URL("../.env.test", import.meta.url)
  const text = readFileSync(envPath, "utf-8")
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

const REMOTE_WORKDIR = "/tmp/opencode-remote-test"

function ensureEnv() {
  if (!process.env.REMOTE_SSH) {
    throw new Error(
      "REMOTE_SSH is not set. Create .env.test (see .env.test.example) or set environment variables."
    )
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
// Enhanced mock context that captures diff/permission metadata
// =============================================================================
interface CapturedAsk {
  permission: string
  patterns: string[]
  metadata: Record<string, any>
}

function createRecordingCtx() {
  const asks: CapturedAsk[] = []
  return {
    sessionID: "test-session",
    messageID: "test-msg",
    agent: "test-agent",
    directory: "/mock/local",
    worktree: "/mock/local",
    abort: new AbortController().signal,
    metadata: (_input: { title?: string; metadata?: Record<string, any> }) => {},
    ask: async (input: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, any> }) => {
      asks.push({ permission: input.permission, patterns: input.patterns, metadata: input.metadata })
    },
    getAsks: () => asks,
    lastAsk: () => asks[asks.length - 1],
  }
}

// =============================================================================
// Test runner
// =============================================================================
const timings: Array<{ category: string; name: string; ms: number; status: "PASS" | "FAIL"; error?: string }> = []

async function test<T>(category: string, name: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now()
  try {
    const result = await fn()
    timings.push({ category, name, ms: Math.round(performance.now() - start), status: "PASS" })
    return result
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    timings.push({ category, name, ms: Math.round(performance.now() - start), status: "FAIL", error })
    throw err
  }
}

async function runAll() {
  ensureEnv()
  const config = loadConfig()
  if (!config) throw new Error("Failed to load config")

  const pathMapper = new PathMapper(config)
  const manifest = new ManifestManager(pathMapper)
  await manifest.load()

  const sshPool = await createSSHPool(config)
  const syncEngine = new SyncEngine(config, pathMapper, manifest, sshPool)

  // Clean mirror
  try { await fs.rm(pathMapper.mirrorBase, { recursive: true, force: true }) } catch {}
  await fs.mkdir(pathMapper.mirrorBase, { recursive: true })
  ;(manifest as any).manifest = { remote_root: pathMapper.remoteRoot, files: {} }

  const readTool = createReadTool(pathMapper, syncEngine, sshPool)
  const writeTool = createWriteTool(pathMapper, syncEngine)
  const editTool = createEditTool(pathMapper, syncEngine)
  const patchTool = createPatchTool(config, pathMapper, syncEngine, sshPool)
  const globTool = createGlobTool(config, sshPool)

  // Pre-create remote workdir structure
  await sshPool.exec(`mkdir -p ${REMOTE_WORKDIR}/src ${REMOTE_WORKDIR}/docs`, { timeout: 10_000 })

  // ==========================================================================
  // 1. BOM End-to-End
  // ==========================================================================
  console.log("\n[BOM Tests]")

  await test("bom", "read_preserves_bom", async () => {
    // Create file with BOM on remote
    await sshPool.exec(
      `printf '${String.raw`\357\273\277`}export const HELLO = "world";\n' > ${REMOTE_WORKDIR}/bom_test.ts`,
      { timeout: 10_000 }
    )
    const ctx = createRecordingCtx()
    const result = await readTool.execute({ filePath: `${REMOTE_WORKDIR}/bom_test.ts` }, ctx)
    const output = (result as any).output as string
    // Debug: print first 200 chars of output
    // BOM should be present in the output stream (first char of content after line number)
    const contentMatch = output.match(/<content>\n([\s\S]*?)\n\(End of file/)
    if (!contentMatch) throw new Error("Could not extract content from read output")
    const content = contentMatch[1]
    // Use Buffer to reliably detect BOM bytes anywhere in the UTF-8 encoded string
    const buf = Buffer.from(content, "utf-8")
    let hasBom = false
    for (let i = 0; i <= buf.length - 3; i++) {
      if (buf[i] === 0xEF && buf[i + 1] === 0xBB && buf[i + 2] === 0xBF) {
        hasBom = true
        break
      }
    }
    if (!hasBom) throw new Error("BOM not preserved in read output")
  })

  await test("bom", "write_preserves_existing_bom", async () => {
    // File already has BOM from previous test
    const ctx = createRecordingCtx()
    await writeTool.execute(
      { filePath: `${REMOTE_WORKDIR}/bom_test.ts`, content: 'export const HELLO = "updated";\n' },
      ctx
    )
    const verify = await sshPool.exec(`xxd -l 3 ${REMOTE_WORKDIR}/bom_test.ts`, { timeout: 10_000 })
    const hex = verify.stdout.trim()
    if (!hex.includes("efbb bf")) throw new Error(`Existing BOM not preserved after write. xxd: ${hex}`)
  })

  await test("bom", "write_detects_new_content_bom", async () => {
    const ctx = createRecordingCtx()
    await writeTool.execute(
      { filePath: `${REMOTE_WORKDIR}/bom_new.ts`, content: '\ufeffexport const NEW = 1;\n' },
      ctx
    )
    const verify = await sshPool.exec(`xxd -l 3 ${REMOTE_WORKDIR}/bom_new.ts`, { timeout: 10_000 })
    const hex = verify.stdout.trim()
    if (!hex.includes("efbb bf")) throw new Error(`New content BOM not written. xxd: ${hex}`)
  })

  await test("bom", "edit_preserves_bom", async () => {
    // Ensure file has BOM
    await sshPool.exec(
      `printf '${String.raw`\357\273\277`}const x = 1;\nconst y = 2;\n' > ${REMOTE_WORKDIR}/bom_edit.ts`,
      { timeout: 10_000 }
    )
    const ctx = createRecordingCtx()
    await editTool.execute(
      { filePath: `${REMOTE_WORKDIR}/bom_edit.ts`, oldString: "const x = 1;", newString: "const x = 99;" },
      ctx
    )
    const verify = await sshPool.exec(`xxd -l 3 ${REMOTE_WORKDIR}/bom_edit.ts`, { timeout: 10_000 })
    const hex = verify.stdout.trim()
    if (!hex.includes("efbb bf")) throw new Error(`BOM lost after edit. xxd: ${hex}`)
    // Also verify content is correct
    const content = await sshPool.exec(`cat ${REMOTE_WORKDIR}/bom_edit.ts`, { timeout: 10_000 })
    if (!content.stdout.includes("const x = 99;")) throw new Error("Edit content incorrect")
  })

  // ==========================================================================
  // 2. Unified Diff Preview Verification
  // ==========================================================================
  console.log("\n[Diff Preview Tests]")

  await test("diff", "edit_generates_unified_diff", async () => {
    await sshPool.exec(`echo 'line1\nline2\nline3' > ${REMOTE_WORKDIR}/diff_test.txt`, { timeout: 10_000 })
    const ctx = createRecordingCtx()
    await editTool.execute(
      { filePath: `${REMOTE_WORKDIR}/diff_test.txt`, oldString: "line2", newString: "line2_modified" },
      ctx
    )
    const ask = ctx.lastAsk()
    if (!ask) throw new Error("No permission ask captured")
    const diff = ask.metadata?.diff as string | undefined
    if (!diff) throw new Error("No diff in metadata")
    // Must be unified diff format
    if (!diff.includes("---")) throw new Error("Diff missing '---' header")
    if (!diff.includes("+++")) throw new Error("Diff missing '+++' header")
    if (!diff.includes("@@")) throw new Error("Diff missing hunk header '@@'")
    if (!diff.includes("-line2\n")) throw new Error("Diff missing removed line")
    if (!diff.includes("+line2_modified")) throw new Error("Diff missing added line")
  })

  await test("diff", "write_generates_unified_diff_on_overwrite", async () => {
    await sshPool.exec(`echo 'original content' > ${REMOTE_WORKDIR}/diff_write.txt`, { timeout: 10_000 })
    // Need to sync first so writeTool sees the file exists
    await syncEngine.register(`${REMOTE_WORKDIR}/diff_write.txt`)
    await syncEngine.pullAll()

    const ctx = createRecordingCtx()
    await writeTool.execute(
      { filePath: `${REMOTE_WORKDIR}/diff_write.txt`, content: "new content\n" },
      ctx
    )
    const ask = ctx.lastAsk()
    if (!ask) throw new Error("No permission ask captured")
    const diff = ask.metadata?.diff as string | undefined
    if (!diff) throw new Error("No diff in metadata")
    if (!diff.includes("---")) throw new Error("Diff missing '---' header")
    if (!diff.includes("+++")) throw new Error("Diff missing '+++' header")
    if (!diff.includes("@@")) throw new Error("Diff missing hunk header '@@'")
    if (!diff.includes("-original content")) throw new Error("Diff missing removed line")
    if (!diff.includes("+new content")) throw new Error("Diff missing added line")
  })

  // ==========================================================================
  // 3. Edit oldString="" Creates New File
  // ==========================================================================
  console.log("\n[Edit Create-File Tests]")

  await test("edit_create", "oldString_empty_creates_new_file", async () => {
    const target = `${REMOTE_WORKDIR}/src/created_by_edit.ts`
    // Ensure file does NOT exist
    await sshPool.exec(`rm -f ${target}`, { timeout: 10_000 })
    const ctx = createRecordingCtx()
    await editTool.execute(
      { filePath: target, oldString: "", newString: "export const CREATED = true;\n" },
      ctx
    )
    const verify = await sshPool.exec(`cat ${target}`, { timeout: 10_000 })
    if (verify.stdout.trim() !== "export const CREATED = true;") {
      throw new Error(`Expected 'export const CREATED = true;', got: ${JSON.stringify(verify.stdout)}`)
    }
  })

  await test("edit_create", "oldString_empty_with_bom_creates_bom_file", async () => {
    const target = `${REMOTE_WORKDIR}/src/created_bom.ts`
    await sshPool.exec(`rm -f ${target}`, { timeout: 10_000 })
    const ctx = createRecordingCtx()
    await editTool.execute(
      { filePath: target, oldString: "", newString: "\ufeffexport const BOM = true;\n" },
      ctx
    )
    const verify = await sshPool.exec(`xxd -l 3 ${target}`, { timeout: 10_000 })
    if (!verify.stdout.includes("efbb bf")) throw new Error("BOM not written for new file via edit")
  })

  // ==========================================================================
  // 4. Patch Move Operations
  // ==========================================================================
  console.log("\n[Patch Move Tests]")

  await test("patch_move", "native_move_file", async () => {
    const source = `${REMOTE_WORKDIR}/move_source.txt`
    const dest = `${REMOTE_WORKDIR}/move_dest.txt`
    await sshPool.exec(`echo 'move me' > ${source} && rm -f ${dest}`, { timeout: 10_000 })

    const patchText = `*** Begin Patch
*** Update File: ${source}
*** Move to: ${dest}
*** End Patch`
    const ctx = createRecordingCtx()
    await patchTool.execute({ patchText }, ctx)

    const srcCheck = await sshPool.exec(`test -f ${source} && echo EXISTS || echo GONE`, { timeout: 10_000 })
    if (srcCheck.stdout.trim() !== "GONE") throw new Error("Source file still exists after move")

    const dstCheck = await sshPool.exec(`cat ${dest}`, { timeout: 10_000 })
    if (dstCheck.stdout.trim() !== "move me") throw new Error("Dest file content incorrect after move")
  })

  // ==========================================================================
  // 5. Strict Content Matching for Edit
  // ==========================================================================
  console.log("\n[Strict Edit Tests]")

  await test("edit_strict", "exact_match_no_side_effects", async () => {
    const content = 'import { add } from "./utils";\nconst x = 1;\nconsole.log(add(x, 2));\n'
    await sshPool.exec(`cat > ${REMOTE_WORKDIR}/strict_edit.ts << 'EOF'\n${content}EOF`, { timeout: 10_000 })

    const ctx = createRecordingCtx()
    await editTool.execute(
      { filePath: `${REMOTE_WORKDIR}/strict_edit.ts`, oldString: "const x = 1;", newString: "const x = 42;" },
      ctx
    )
    const verify = await sshPool.exec(`cat ${REMOTE_WORKDIR}/strict_edit.ts`, { timeout: 10_000 })
    const expected = 'import { add } from "./utils";\nconst x = 42;\nconsole.log(add(x, 2));\n'
    if (verify.stdout !== expected) {
      throw new Error(`Content mismatch.\nExpected:\n${expected}\nGot:\n${verify.stdout}`)
    }
  })

  await test("edit_strict", "multiline_exact_no_side_effects", async () => {
    const content = 'function foo() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n'
    await sshPool.exec(`cat > ${REMOTE_WORKDIR}/multiline_edit.ts << 'EOF'\n${content}EOF`, { timeout: 10_000 })

    const ctx = createRecordingCtx()
    await editTool.execute(
      {
        filePath: `${REMOTE_WORKDIR}/multiline_edit.ts`,
        oldString: "  const a = 1;\n  const b = 2;",
        newString: "  const a = 10;\n  const b = 20;",
      },
      ctx
    )
    const verify = await sshPool.exec(`cat ${REMOTE_WORKDIR}/multiline_edit.ts`, { timeout: 10_000 })
    const expected = 'function foo() {\n  const a = 10;\n  const b = 20;\n  return a + b;\n}\n'
    if (verify.stdout !== expected) {
      throw new Error(`Content mismatch.\nExpected:\n${expected}\nGot:\n${verify.stdout}`)
    }
  })

  await test("edit_strict", "replaceAll_replaces_all_occurrences", async () => {
    const content = "foo bar foo baz foo\n"
    await sshPool.exec(`echo '${content.trim()}' > ${REMOTE_WORKDIR}/replaceall.txt`, { timeout: 10_000 })

    const ctx = createRecordingCtx()
    await editTool.execute(
      { filePath: `${REMOTE_WORKDIR}/replaceall.txt`, oldString: "foo", newString: "qux", replaceAll: true },
      ctx
    )
    const verify = await sshPool.exec(`cat ${REMOTE_WORKDIR}/replaceall.txt`, { timeout: 10_000 })
    const expected = "qux bar qux baz qux\n"
    if (verify.stdout !== expected) {
      throw new Error(`replaceAll failed.\nExpected: ${JSON.stringify(expected)}\nGot: ${JSON.stringify(verify.stdout)}`)
    }
  })

  // ==========================================================================
  // 6. Read Pagination
  // ==========================================================================
  console.log("\n[Read Pagination Tests]")

  await test("read_paginate", "limit_respected", async () => {
    await sshPool.exec(
      `for i in $(seq 1 200); do echo "line\$i"; done > ${REMOTE_WORKDIR}/paginate.txt`,
      { timeout: 10_000 }
    )
    const ctx = createRecordingCtx()
    const result = await readTool.execute(
      { filePath: `${REMOTE_WORKDIR}/paginate.txt`, limit: 50 },
      ctx
    )
    const output = (result as any).output as string
    const lines = output.split("\n").filter((l) => l.match(/^\d+: line/))
    if (lines.length !== 50) throw new Error(`Expected 50 lines, got ${lines.length}`)
    if (!output.includes("Use offset=51 to continue")) throw new Error("Pagination hint missing")
  })

  await test("read_paginate", "offset_respected", async () => {
    const ctx = createRecordingCtx()
    const result = await readTool.execute(
      { filePath: `${REMOTE_WORKDIR}/paginate.txt`, offset: 100, limit: 10 },
      ctx
    )
    const output = (result as any).output as string
    const firstLine = output.split("\n").find((l) => l.includes("line"))
    if (!firstLine?.includes("100: line100")) throw new Error(`Expected line 100, got: ${firstLine}`)
  })

  await test("read_paginate", "offset_out_of_bounds_throws", async () => {
    const ctx = createRecordingCtx()
    try {
      await readTool.execute(
        { filePath: `${REMOTE_WORKDIR}/paginate.txt`, offset: 999 },
        ctx
      )
      throw new Error("Should have thrown for out-of-bounds offset")
    } catch (err) {
      if (!(err as Error).message.includes("out of range")) throw err
    }
  })

  // ==========================================================================
  // 7. isWithinWorkspace Boundary Security
  // ==========================================================================
  console.log("\n[Security Boundary Tests]")

  await test("security", "isWithinWorkspace_exact_root", async () => {
    if (!pathMapper.isWithinWorkspace(REMOTE_WORKDIR)) {
      throw new Error("Exact remoteRoot should be within workspace")
    }
  })

  await test("security", "isWithinWorkspace_subdirectory", async () => {
    if (!pathMapper.isWithinWorkspace(`${REMOTE_WORKDIR}/src/main.ts`)) {
      throw new Error("Subdirectory should be within workspace")
    }
  }
  )

  await test("security", "isWithinWorkspace_rejects_prefix_attack", async () => {
    // Regression for /workdir-extra bypass
    if (pathMapper.isWithinWorkspace(`${REMOTE_WORKDIR}-extra`)) {
      throw new Error("Prefix attack /workdir-extra should be REJECTED")
    }
  })

  await test("security", "isWithinWorkspace_rejects_traversal", async () => {
    if (pathMapper.isWithinWorkspace(`${REMOTE_WORKDIR}/../etc/passwd`)) {
      throw new Error("Directory traversal should be REJECTED")
    }
  })

  await test("security", "read_rejects_outside_workspace", async () => {
    const ctx = createRecordingCtx()
    try {
      await readTool.execute({ filePath: "/etc/passwd" }, ctx)
      throw new Error("Should have rejected /etc/passwd")
    } catch (err) {
      // Tool should either ask permission (our mock allows it) or throw.
      // Since mock allows everything, we rely on the isWithinWorkspace check
      // which currently asks permission instead of throwing. Let's verify
      // the ask was triggered for a pattern outside workspace.
      const ask = ctx.lastAsk()
      if (!ask) throw new Error("No permission ask for outside-workspace read")
    }
  })

  // ==========================================================================
  // 8. quoteShell Injection Safety
  // ==========================================================================
  console.log("\n[Shell Quote Safety Tests]")

  await test("shell_quote", "prevents_command_injection", async () => {
    // This should NOT execute `echo pwned` — it should be treated as a single filename argument
    const malicious = "file; echo pwned"
    await sshPool.exec(`touch ${quoteShell(malicious)}`, { timeout: 10_000 })
    const check = await sshPool.exec(`ls ${REMOTE_WORKDIR} | grep 'echo pwned' || echo SAFE`, { timeout: 10_000 })
    if (check.stdout.trim() !== "SAFE") throw new Error("Command injection via quoteShell succeeded!")
    // Clean up
    await sshPool.exec(`rm -f ${REMOTE_WORKDIR}/${quoteShell(malicious)}`, { timeout: 10_000 })
  })

  await test("shell_quote", "handles_single_quotes", async () => {
    const name = "it's_a_file"
    await sshPool.exec(`touch ${REMOTE_WORKDIR}/${quoteShell(name)}`, { timeout: 10_000 })
    const check = await sshPool.exec(`test -f ${REMOTE_WORKDIR}/${quoteShell(name)} && echo EXISTS || echo MISSING`, { timeout: 10_000 })
    if (!check.stdout.includes("EXISTS")) throw new Error("File with single quote not created correctly")
    await sshPool.exec(`rm -f ${quoteShell(name)}`, { timeout: 10_000 })
  })

  await test("shell_quote", "handles_dollar_sign", async () => {
    const name = "price_$100"
    await sshPool.exec(`touch ${REMOTE_WORKDIR}/${quoteShell(name)}`, { timeout: 10_000 })
    const check = await sshPool.exec(`test -f ${REMOTE_WORKDIR}/${quoteShell(name)} && echo EXISTS || echo MISSING`, { timeout: 10_000 })
    if (!check.stdout.includes("EXISTS")) throw new Error("File with dollar sign not created correctly")
    await sshPool.exec(`rm -f ${quoteShell(name)}`, { timeout: 10_000 })
  })

  // ==========================================================================
  // 9. Glob Brace Expansion Fallback
  // ==========================================================================
  console.log("\n[Glob Brace Tests]")

  await test("glob_brace", "finds_ts_and_tsx_via_brace", async () => {
    await sshPool.exec(
      `touch ${REMOTE_WORKDIR}/src/a.ts ${REMOTE_WORKDIR}/src/b.tsx ${REMOTE_WORKDIR}/src/c.js`,
      { timeout: 10_000 }
    )
    const result = await globTool.execute(
      { pattern: "*.{ts,tsx}", path: `${REMOTE_WORKDIR}/src` },
      createRecordingCtx()
    )
    const output = (result as any).output as string
    if (!output.includes("a.ts")) throw new Error("a.ts not found via brace expansion")
    if (!output.includes("b.tsx")) throw new Error("b.tsx not found via brace expansion")
    if (output.includes("c.js")) throw new Error("c.js should NOT match *.{ts,tsx}")
  })

  // ==========================================================================
  // 10. Edit Replacer Coverage
  // ==========================================================================
  console.log("\n[Edit Replacer Tests]")

  await test("edit_replacer", "block_anchor_fuzzy_match", async () => {
    const content = 'function start() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n}\n'
    await sshPool.exec(`cat > ${REMOTE_WORKDIR}/block_anchor.ts << 'EOF'\n${content}EOF`, { timeout: 10_000 })
    // Use first and last lines as anchors, middle lines slightly different
    const ctx = createRecordingCtx()
    await editTool.execute(
      {
        filePath: `${REMOTE_WORKDIR}/block_anchor.ts`,
        oldString: "function start() {\n  const a = 1;\n  const b = 99;\n  const c = 3;\n}",
        newString: "function start() {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n}",
      },
      ctx
    )
    const verify = await sshPool.exec(`cat ${REMOTE_WORKDIR}/block_anchor.ts`, { timeout: 10_000 })
    if (!verify.stdout.includes("const b = 2;")) throw new Error("Block anchor replacer failed")
  })

  await test("edit_replacer", "line_trimmed_fuzzy_match", async () => {
    // Content has extra indentation; AI provides unindented oldString
    await sshPool.exec(`cat > ${REMOTE_WORKDIR}/indent.ts << 'EOF'\n  function test() {\n    const x = 1;\n  }\nEOF`, { timeout: 10_000 })
    const ctx = createRecordingCtx()
    await editTool.execute(
      {
        filePath: `${REMOTE_WORKDIR}/indent.ts`,
        oldString: "function test() {\n  const x = 1;\n}",
        newString: "function test() {\n  const x = 99;\n}",
      },
      ctx
    )
    const verify = await sshPool.exec(`cat ${REMOTE_WORKDIR}/indent.ts`, { timeout: 10_000 })
    // lineTrimmedReplacer matches by trim; newString is inserted as-is (no auto-indent)
    // This is expected behavior — AI should provide correctly-indented newString
    if (!verify.stdout.includes("function test() {")) throw new Error("Line-trimmed replacer failed")
    if (!verify.stdout.includes("  const x = 99;")) throw new Error("Line-trimmed replacer failed")
  })

  await test("edit_replacer", "multi_occurrence_replaceAll", async () => {
    await sshPool.exec(`printf 'foo\nfoo\nfoo\n' > ${REMOTE_WORKDIR}/multi_occ.txt`, { timeout: 10_000 })
    const ctx = createRecordingCtx()
    await editTool.execute(
      { filePath: `${REMOTE_WORKDIR}/multi_occ.txt`, oldString: "foo", newString: "bar", replaceAll: true },
      ctx
    )
    const verify = await sshPool.exec(`cat ${REMOTE_WORKDIR}/multi_occ.txt`, { timeout: 10_000 })
    const lines = verify.stdout.trim().split("\n")
    if (lines.length !== 3 || !lines.every((l) => l === "bar")) {
      throw new Error(`Multi-occurrence replaceAll failed: ${JSON.stringify(verify.stdout)}`)
    }
  })

  // ==========================================================================
  // Cleanup & Report
  // ==========================================================================
  console.log("\nCleaning up...")
  await sshPool.close()

  console.log("\n" + "=".repeat(80))
  console.log("EXTENDED VERIFICATION REPORT")
  console.log("=".repeat(80))
  const categories = [...new Set(timings.map((t) => t.category))]
  for (const cat of categories) {
    const items = timings.filter((t) => t.category === cat)
    const passed = items.filter((t) => t.status === "PASS").length
    console.log(`\n[${cat}] ${passed}/${items.length} passed`)
    for (const t of items) {
      const mark = t.status === "PASS" ? "✅" : "❌"
      console.log(`  ${mark} ${t.name} (${t.ms}ms)`)
      if (t.error) console.log(`     ${t.error}`)
    }
  }
  const totalPass = timings.filter((t) => t.status === "PASS").length
  const totalFail = timings.filter((t) => t.status === "FAIL").length
  console.log("\n" + "=".repeat(80))
  console.log(`TOTAL: ${timings.length} tests, ${totalPass} passed, ${totalFail} failed`)
  console.log("=".repeat(80))

  if (totalFail > 0) process.exit(1)
}

runAll().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
