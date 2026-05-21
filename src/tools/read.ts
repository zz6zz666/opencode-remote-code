import fs from "fs/promises"
import path from "path"
import { tool } from "@opencode-ai/plugin"
import type { PathMapper } from "../path-mapper.js"
import type { SSHPool } from "../ssh-pool.js"
import type { SyncEngine } from "../sync-engine.js"


const DEFAULT_LIMIT = 2000
const MAX_BYTES = 50 * 1024
const MAX_LINE_LENGTH = 2000

const BINARY_EXTENSIONS = new Set([
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".bin",
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".svg",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".pyc", ".pyo", ".class", ".o", ".a", ".obj",
  ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".wav",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
])

function isBinaryByExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return BINARY_EXTENSIONS.has(ext)
}

async function checkRemoteBinary(
  sshPool: SSHPool,
  remotePath: string
): Promise<{ isBinary: boolean; reason?: string }> {
  // 1. Extension blacklist
  if (isBinaryByExtension(remotePath)) {
    return { isBinary: true, reason: "binary extension" }
  }

  // 2. Remote file command check
  const fileResult = await sshPool.exec(
    `file -b ${quoteShell(remotePath)} 2>/dev/null || echo "UNKNOWN"`,
    { timeout: 10_000 }
  )
  const fileDesc = fileResult.stdout.trim().toLowerCase()
  if (fileDesc !== "unknown" && !fileDesc.includes("text") && !fileDesc.includes("empty")) {
    return { isBinary: true, reason: `file type: ${fileResult.stdout.trim()}` }
  }

  // 3. Remote null-byte check in first 4KB (fallback when file cmd unavailable or ambiguous)
  const nullCheck = await sshPool.exec(
    `dd bs=4096 count=1 if=${quoteShell(remotePath)} 2>/dev/null | od -An -tx1 | grep -q ' 00 ' && echo HAS_NULL || echo NO_NULL`,
    { timeout: 10_000 }
  )
  if (nullCheck.stdout.trim() === "HAS_NULL") {
    return { isBinary: true, reason: "null bytes detected" }
  }

  return { isBinary: false }
}

export function createReadTool(pathMapper: PathMapper, syncEngine: SyncEngine, sshPool: SSHPool) {
  return tool({
    description: `Read the contents of a file or list a directory on the remote machine.`,
    args: {
      filePath: tool.schema.string().describe("The absolute path to the file or directory to read"),
      offset: tool.schema.number().optional().describe("The line number to start reading from (1-indexed)"),
      limit: tool.schema.number().optional().describe("The maximum number of lines to read (defaults to 2000)"),
    },
    async execute(args, ctx) {
      let remotePath = path.posix.normalize(args.filePath)
      if (!path.posix.isAbsolute(remotePath)) {
        remotePath = path.posix.join(pathMapper.remoteRoot, remotePath)
      }
      if (!pathMapper.isWithinWorkspace(remotePath)) {
        await ctx.ask({
          permission: "read",
          patterns: [remotePath],
          always: [remotePath],
          metadata: {},
        })
      }

      const localPath = pathMapper.toLocal(remotePath)
      const limit = args.limit ?? DEFAULT_LIMIT
      const offset = (args.offset ?? 1) - 1

      // Determine remote type (file / directory / missing)
      const typeResult = await sshPool.exec(
        `if [ -d ${quoteShell(remotePath)} ]; then echo "DIR"; elif [ -f ${quoteShell(remotePath)} ]; then echo "FILE"; else echo "MISSING"; fi`,
        { timeout: 10_000 }
      )
      const remoteType = typeResult.stdout.trim()

      if (remoteType === "DIR") {
        const result = await sshPool.exec(
          `ls -1pA ${quoteShell(remotePath)}`,
          { timeout: 15_000 }
        )
        const items = result.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
        items.sort((a, b) => a.localeCompare(b))
        const start = offset
        const sliced = items.slice(start, start + limit)
        const truncated = start + sliced.length < items.length

        return {
          title: remotePath,
          output: [
            `<path>${remotePath}</path>`,
            `<type>directory</type>`,
            `<entries>`,
            sliced.join("\n"),
            truncated
              ? `\n(Showing ${sliced.length} of ${items.length} entries. Use 'offset' parameter to read beyond entry ${offset + sliced.length + 1})`
              : `\n(${items.length} entries)`,
            `</entries>`,
          ].join("\n"),
          metadata: { preview: sliced.slice(0, 20).join("\n"), truncated },
        }
      }

      if (remoteType === "MISSING") {
        // Suggest similar files from remote parent directory
        const remoteDir = path.posix.dirname(remotePath)
        const base = path.posix.basename(remotePath).toLowerCase()
        let suggestions: string[] = []
        try {
          const result = await sshPool.exec(`ls -1A ${quoteShell(remoteDir)}`, { timeout: 10_000 })
          const items = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
          suggestions = items
            .filter((i) => i.toLowerCase().includes(base) || base.includes(i.toLowerCase()))
            .slice(0, 3)
        } catch {}
        if (suggestions.length > 0) {
          throw new Error(
            `File not found: ${remotePath}\n\nDid you mean one of these?\n${suggestions.join("\n")}`
          )
        }
        throw new Error(`File not found: ${remotePath}`)
      }

      // For files: check binary on remote BEFORE syncing
      const binaryCheck = await checkRemoteBinary(sshPool, remotePath)
      if (binaryCheck.isBinary) {
        throw new Error(
          `Cannot read binary file: ${remotePath}\n\nReason: ${binaryCheck.reason}. Use bash tools to inspect it if needed.`
        )
      }

      // Safe to sync: it's a text file
      await syncEngine.register(remotePath)
      await syncEngine.pullAll()

      const buf = await fs.readFile(localPath)
      // ignoreBOM: true preserves the BOM as a regular character in the output
      // (false would consume/remove it, which is what readFileWithBom does for editing)
      const content = new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf)
      const lines = content.split("\n")

      // Offset validation
      if (offset > lines.length && lines.length > 0) {
        throw new Error(`Offset ${args.offset} is out of range (file has ${lines.length} lines)`)
      }

      const start = offset
      let bytes = 0
      const out: string[] = []
      let cut = false
      let more = false

      for (let i = start; i < lines.length; i++) {
        if (out.length >= limit) {
          more = true
          break
        }
        let line = lines[i]
        // Line length truncation
        if (line.length > MAX_LINE_LENGTH) {
          line = line.substring(0, MAX_LINE_LENGTH) + " ... (line truncated)"
        }
        const size = Buffer.byteLength(line, "utf-8") + (out.length > 0 ? 1 : 0)
        if (bytes + size > MAX_BYTES) {
          cut = true
          more = true
          break
        }
        out.push(line)
        bytes += size
      }

      let output = [`<path>${remotePath}</path>`, `<type>file</type>`, "<content>\n"].join("\n")
      output += out.map((line, i) => `${i + start + 1}: ${line}`).join("\n")
      const last = start + out.length
      if (cut) {
        output += `\n\n(Output capped at ${MAX_BYTES / 1024} KB. Showing lines ${start + 1}-${last}. Use offset=${last + 1} to continue.)`
      } else if (more) {
        output += `\n\n(Showing lines ${start + 1}-${last} of ${lines.length}. Use offset=${last + 1} to continue.)`
      } else {
        output += `\n\n(End of file - total ${lines.length} lines)`
      }
      output += "\n</content>"

      return {
        title: remotePath,
        output,
        metadata: {
          preview: out.slice(0, 20).join("\n"),
          truncated: more || cut,
        },
      }
    },
  })
}

function quoteShell(input: string): string {
  if (/^[a-zA-Z0-9_.\/\-]+$/.test(input)) return input
  return `"${input.replace(/"/g, '\\"')}"`
}
