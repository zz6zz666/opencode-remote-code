import { tool } from "@opencode-ai/plugin"
import type { RemoteConfig } from "../config.js"
import type { SSHPool } from "../ssh-pool.js"

export function createGlobTool(config: RemoteConfig, sshPool: SSHPool) {
  return tool({
    description: `Find files matching a glob pattern on the remote machine.`,
    args: {
      pattern: tool.schema.string().describe("The glob pattern to match files against"),
      path: tool.schema.string().optional().describe("The directory to search in. Omit to use the default directory."),
    },
    async execute(args, ctx) {
      const searchDir = args.path || config.remoteWorkdir
      const limit = 100

      // Try ripgrep with reverse-time sorting first
      const escapedPattern = args.pattern.replace(/'/g, "'\"'\"'")
      const rgCmd = `cd ${quoteShell(searchDir)} && rg --files --sortr=modified --glob '${escapedPattern}' 2>/dev/null`
      let result = await sshPool.exec(rgCmd, { timeout: 30_000 })

      let lines: string[]

      if (result.stdout.trim()) {
        lines = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
      } else {
        // Fallback: find + stat for sorting
        // find -name does NOT support brace expansion, so we expand manually.
        const namePredicate = buildFindNamePredicate(args.pattern)
        const findCmd = `cd ${quoteShell(searchDir)} && find . -maxdepth 10 ${namePredicate} -type f -exec stat -c '%Y %n' {} + 2>/dev/null | sort -rn | cut -d' ' -f2-`
        result = await sshPool.exec(findCmd, { timeout: 30_000 })
        lines = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
      }

      // Deduplicate and limit
      const seen = new Set<string>()
      const files: string[] = []
      for (const line of lines) {
        const full = line.startsWith("/") ? line : searchDir + "/" + line.replace(/^\.\//, "")
        if (seen.has(full)) continue
        seen.add(full)
        files.push(full)
        if (files.length >= limit + 1) break
      }

      const truncated = files.length > limit
      if (truncated) files.length = limit

      const output: string[] = []
      if (files.length === 0) output.push("No files found")
      else {
        output.push(...files)
        if (truncated) {
          output.push(``)
          output.push(`(Results are truncated: showing first ${limit} results. Consider using a more specific path or pattern.)`)
        }
      }

      return {
        title: searchDir,
        output: output.join("\n"),
        metadata: {
          count: files.length,
          truncated,
        },
      }
    },
  })
}

import { quoteShell } from "../shell-quote.js"

/**
 * Convert a glob pattern into a `find` -name predicate.
 * Handles simple brace expansion: *.{ts,tsx} → \( -name '*.ts' -o -name '*.tsx' \)
 * Also strips leading double-star-slash because find is already recursive.
 */
function buildFindNamePredicate(pattern: string): string {
  // find traverses recursively by default, so **/ is redundant for -name
  const normalized = pattern.startsWith("**/") ? pattern.slice(3) : pattern

  const braceMatch = normalized.match(/^(.*)\{([^}]+)\}(.*)$/)
  if (!braceMatch) {
    return `-name ${quoteShell(normalized)}`
  }
  const prefix = braceMatch[1]
  const options = braceMatch[2]
  const suffix = braceMatch[3]
  const parts = options.split(",").map((opt) => `-name ${quoteShell(prefix + opt + suffix)}`)
  return `\\( ${parts.join(" -o ")} \\)`
}
