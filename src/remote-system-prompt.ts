import type { SSHPool } from "./ssh-pool.js"
import { getProviderPrompt } from "./prompts/index.js"

export interface RemoteSystemPromptContext {
  modelID: string
  remoteWorkdir: string
  remotePlatform: string
  isGitRepo: boolean
  sshPool: SSHPool
}

export async function buildRemoteSystemPrompt(
  ctx: RemoteSystemPromptContext,
  originalSystem: string[]
): Promise<string[]> {
  // 1. Determine provider prompt based on model
  const providerPrompt = getProviderPrompt(ctx.modelID)

  // 2. Build remote environment block
  const envBlock = [
    `You are powered by the model named ${ctx.modelID}.`,
    `Here is some useful information about the environment you are running in:`,
    `<env>`,
    `  Working directory: ${ctx.remoteWorkdir}`,
    `  Workspace root folder: ${ctx.remoteWorkdir}`,
    `  Is directory a git repo: ${ctx.isGitRepo ? "yes" : "no"}`,
    `  Platform: ${ctx.remotePlatform}`,
    `  Today's date: ${new Date().toDateString()}`,
    `</env>`,
  ].join("\n")

  // 3. Load remote AGENTS.md if exists
  let remoteAgents = ""
  try {
    const result = await ctx.sshPool.exec(
      `cat "${ctx.remoteWorkdir}/AGENTS.md" 2>/dev/null || echo "__NO_AGENTS_MD__"`,
      { timeout: 10_000 }
    )
    if (result.stdout.trim() && !result.stdout.includes("__NO_AGENTS_MD__")) {
      remoteAgents = `Instructions from: ${ctx.remoteWorkdir}/AGENTS.md\n${result.stdout.trim()}`
    }
  } catch {
    // ignore
  }

  // 4. Extract skills section from original system prompt
  const skillsSection = extractSkillsSection(originalSystem)

  // 5. Assemble the new system prompt
  const parts: string[] = [providerPrompt, envBlock]
  if (remoteAgents) parts.push(remoteAgents)
  if (skillsSection) parts.push(skillsSection)

  return [parts.join("\n\n")]
}

function extractSkillsSection(system: string[]): string | undefined {
  // Search from the end of the array backward — skills are typically the last section
  for (let i = system.length - 1; i >= 0; i--) {
    const text = system[i]
    const idx = text.lastIndexOf("Skills provide specialized instructions")
    if (idx !== -1) {
      return text.slice(idx)
    }
  }
  return undefined
}
