import fs from "fs/promises"
import path from "path"
import { tool } from "@opencode-ai/plugin"
import type { PathMapper } from "../path-mapper.js"
import type { SyncEngine } from "../sync-engine.js"
import { createTwoFilesPatch } from "diff"
import { readFileWithBom, joinBom, splitBom } from "../bom.js"
import { trimDiff } from "../diff-utils.js"

export function createWriteTool(pathMapper: PathMapper, syncEngine: SyncEngine) {
  return tool({
    description: `Write content to a file on the remote machine.`,
    args: {
      content: tool.schema.string().describe("The content to write to the file"),
      filePath: tool.schema.string().describe("The absolute path to the file to write (must be absolute)"),
    },
    async execute(args, ctx) {
      let remotePath = path.posix.normalize(args.filePath)
      if (!path.posix.isAbsolute(remotePath)) {
        remotePath = path.posix.join(pathMapper.remoteRoot, remotePath)
      }
      if (!pathMapper.isWithinWorkspace(remotePath)) {
        await ctx.ask({
          permission: "edit",
          patterns: [remotePath],
          always: [remotePath],
          metadata: {},
        })
      }

      const localPath = pathMapper.toLocal(remotePath)
      const existed = await fs.stat(localPath).then((s) => s.isFile(), () => false)

      // Preserve BOM: source.bom || next.bom (OpenCode semantics)
      let bom = false
      let oldContent = ""
      if (existed) {
        await syncEngine.register(remotePath)
        await syncEngine.pullAll()
        try {
          const existing = await readFileWithBom(fs, localPath)
          bom = existing.bom
          oldContent = existing.text
        } catch {}
      }
      bom = bom || splitBom(args.content).bom

      // Build diff preview for permission request
      const diffPreview = existed
        ? generateDiffPreview(remotePath, oldContent, args.content)
        : `A ${remotePath}\n+ ${args.content.split("\n").slice(0, 10).join("\n+ ")}`

      await ctx.ask({
        permission: "edit",
        patterns: [remotePath],
        always: [remotePath],
        metadata: { diff: diffPreview },
      })

      await fs.mkdir(path.dirname(localPath), { recursive: true })
      await fs.writeFile(localPath, joinBom(args.content, bom), "utf-8")

      // Register and push to remote
      await syncEngine.register(remotePath)
      await syncEngine.pushAll()

      return {
        title: remotePath,
        output: "Wrote file successfully.",
        metadata: {
          filepath: remotePath,
          exists: existed,
        },
      }
    },
  })
}

function generateDiffPreview(filePath: string, oldText: string, newText: string): string {
  return trimDiff(createTwoFilesPatch(filePath, filePath, oldText, newText))
}
