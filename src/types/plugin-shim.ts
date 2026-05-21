// Minimal type shim for @opencode-ai/plugin to allow local development
// In production, OpenCode installs the real package automatically.

import { z } from "zod"

export type ToolContext = {
  sessionID: string
  messageID: string
  agent: string
  directory: string
  worktree: string
  abort: AbortSignal
  metadata(input: { title?: string; metadata?: Record<string, any> }): void
  ask(input: {
    permission: string
    patterns: string[]
    always: string[]
    metadata: Record<string, any>
  }): Promise<void>
}

export type ToolAttachment = {
  type: "file"
  mime: string
  url: string
  filename?: string
}

export type ToolResult =
  | string
  | {
      title?: string
      output: string
      metadata?: Record<string, any>
      attachments?: ToolAttachment[]
    }

export type ToolDefinition<Args extends z.ZodRawShape = any> = {
  description: string
  args: Args
  execute(
    args: z.infer<z.ZodObject<Args>>,
    context: ToolContext
  ): Promise<ToolResult>
}

export function tool<Args extends z.ZodRawShape>(input: {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult>
}): ToolDefinition<Args> {
  return input as any
}

tool.schema = z

export type PluginInput = {
  client: any
  project: any
  directory: string
  worktree: string
  serverUrl: URL
  $: any
}

export type PluginOptions = Record<string, unknown>

export type Hooks = {
  tool?: Record<string, ToolDefinition>
  event?: (input: { event: any }) => Promise<void>
  [key: string]: any
}

export type Plugin = (
  input: PluginInput,
  options?: PluginOptions
) => Promise<Hooks>
