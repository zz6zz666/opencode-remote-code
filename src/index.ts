import fs from "fs/promises"
import os from "os"
import path from "path"
import type { Plugin } from "@opencode-ai/plugin"
import { loadConfig } from "./config.js"
import { ManifestManager } from "./manifest.js"
import { PathMapper } from "./path-mapper.js"
import { createSSHPool } from "./ssh-pool.js"
import { SyncEngine } from "./sync-engine.js"
import { createBashTool } from "./tools/bash.js"
import { createEditTool } from "./tools/edit.js"
import { createGlobTool } from "./tools/glob.js"
import { createGrepTool } from "./tools/grep.js"
import { createPatchTool } from "./tools/patch.js"
import { createReadTool } from "./tools/read.js"
import { createWriteTool } from "./tools/write.js"
import { buildRemoteSystemPrompt } from "./remote-system-prompt.js"

async function logDebug(msg: string) {
  const logFile = path.join(os.homedir(), ".opencode", "remote-code-debug.log")
  const line = `[${new Date().toISOString()}] ${msg}\n`
  await fs.appendFile(logFile, line).catch(() => {})
}

const RemoteCodePlugin: Plugin = async (input, options) => {
  await logDebug(`Plugin loaded. options=${JSON.stringify(options)}`)
  await logDebug(`env.REMOTE_SSH=${process.env.REMOTE_SSH}`)
  await logDebug(`env.REMOTE_WORKDIR=${process.env.REMOTE_WORKDIR}`)
  await logDebug(`env.REMOTE_PASSWORD=${process.env.REMOTE_PASSWORD ? "***" : "undefined"}`)

  const config = loadConfig(options)

  if (!config) {
    await logDebug("Config is null - remote mode not activated")
    return {}
  }

  await logDebug(`Config loaded: host=${config.host}, workdir=${config.remoteWorkdir}`)

  const pathMapper = new PathMapper(config)
  const manifest = new ManifestManager(pathMapper)
  await manifest.load()

  const sshPool = await createSSHPool(config)
  const syncEngine = new SyncEngine(config, pathMapper, manifest, sshPool)

  // Clean and recreate mirror base to avoid stale files from previous sessions
  try {
    await fs.rm(pathMapper.mirrorBase, { recursive: true, force: true })
  } catch {}
  await mkdirp(pathMapper.mirrorBase)

  // Reset manifest since we're starting fresh
  ;(manifest as any).manifest = { remote_root: pathMapper.remoteRoot, files: {} }

  // Probe remote environment
  let remotePlatform = "linux"
  let isGitRepo = false
  try {
    const uname = await sshPool.exec("uname -s", { timeout: 5_000 })
    remotePlatform = uname.stdout.trim().toLowerCase()
  } catch {}
  try {
    const gitCheck = await sshPool.exec(
      `git -C "${config.remoteWorkdir}" rev-parse --git-dir 2>/dev/null && echo GIT || echo NO_GIT`,
      { timeout: 5_000 }
    )
    isGitRepo = gitCheck.stdout.trim().includes("GIT")
  } catch {}

  const remoteWorkdir = config.remoteWorkdir

  const tools = {
    bash: createBashTool(sshPool, config.remoteWorkdir),
    glob: createGlobTool(config, sshPool),
    grep: createGrepTool(config, sshPool),
    read: createReadTool(pathMapper, syncEngine, sshPool),
    write: createWriteTool(pathMapper, syncEngine),
    edit: createEditTool(pathMapper, syncEngine),
    apply_patch: createPatchTool(config, pathMapper, syncEngine, sshPool),
  }

  return {
    tool: tools,
    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        await manifest.save()
        await sshPool.close()
      }
    },
    "experimental.chat.system.transform": async (
      _input: { sessionID?: string; model: any },
      output: { system: string[] }
    ) => {
      await logDebug(`system.transform called. modelID=${_input.model?.api?.id ?? _input.model?.id ?? "unknown"}`)

      // Identify title-generator element (preserve it)
      const titleGeneratorIdx = output.system.findIndex((s) =>
        s.includes("You are a title generator")
      )

      // Build remote system prompt to replace everything except title generator
      const remoteSystem = await buildRemoteSystemPrompt(
        {
          modelID: _input.model?.api?.id ?? _input.model?.id ?? "default",
          remoteWorkdir,
          remotePlatform,
          isGitRepo,
          sshPool,
        },
        output.system
      )

      if (titleGeneratorIdx !== -1) {
        // Replace all non-title-generator elements with our remote system prompt
        const titleGenerator = output.system[titleGeneratorIdx]
        output.system.length = 0
        output.system.push(titleGenerator, ...remoteSystem)
      } else {
        // No title generator found — replace entire array
        output.system.length = 0
        output.system.push(...remoteSystem)
      }

      await logDebug(`system.transform done. output.system.length=${output.system.length}`)
    },
  }
}

async function mkdirp(dir: string): Promise<void> {
  const { mkdir } = await import("fs/promises")
  await mkdir(dir, { recursive: true }).catch(() => {})
}

export default {
  id: "remote-code",
  server: RemoteCodePlugin,
}
