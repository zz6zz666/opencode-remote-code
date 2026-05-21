import { readFileSync } from "fs"
import { fileURLToPath } from "url"
import path from "path"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function load(name: string): string {
  return readFileSync(path.join(__dirname, `${name}.txt`), "utf-8")
}

const PROMPTS: Record<string, string> = {
  anthropic: load("anthropic"),
  beast: load("beast"),
  codex: load("codex"),
  default: load("default"),
  gemini: load("gemini"),
  gpt: load("gpt"),
  kimi: load("kimi"),
  trinity: load("trinity"),
}

export function getProviderPrompt(modelID: string): string {
  const id = modelID.toLowerCase()
  if (id.includes("gpt-4") || id.includes("o1") || id.includes("o3")) return PROMPTS.beast
  if (id.includes("gpt")) {
    if (id.includes("codex")) return PROMPTS.codex
    return PROMPTS.gpt
  }
  if (id.includes("gemini-")) return PROMPTS.gemini
  if (id.includes("claude")) return PROMPTS.anthropic
  if (id.includes("trinity")) return PROMPTS.trinity
  if (id.includes("kimi")) return PROMPTS.kimi
  return PROMPTS.default
}
