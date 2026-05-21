import { tool } from "@opencode-ai/plugin"
import type { SSHPool } from "../ssh-pool.js"

export function createBashTool(sshPool: SSHPool, defaultWorkdir: string) {
  return tool({
    description: `Execute commands in a bash shell on the remote machine.`,
    args: {
      command: tool.schema.string().describe("The bash command to execute"),
      description: tool.schema.string().describe("A short description of what the command does"),
      timeout: tool.schema.number().optional().describe("Timeout in milliseconds (optional)"),
      workdir: tool.schema.string().optional().describe("Working directory on the remote machine (optional)"),
    },
    async execute(args, ctx) {
      const timeout = args.timeout ?? 120_000
      if (timeout < 0) {
        throw new Error("Timeout must be a non-negative number")
      }
      const result = await sshPool.exec(args.command, {
        cwd: args.workdir ?? defaultWorkdir,
        timeout,
      })

      let stdout = result.stdout || ""
      let stderr = result.stderr || ""

      // Filter out SSH connection noise from stderr
      stderr = filterSshNoise(stderr)

      // CentOS 6 / OpenSSH 5.3 does not reliably propagate exit codes through
      // the SSH exec channel. Fall back to stderr heuristics when exitCode is 0
      // but stderr indicates a clear failure.
      const stderrErrors = [
        "command not found",
        "no such file or directory",
        "permission denied",
        "sorry, you must have a tty to run sudo",
      ]
      const hasStderrError = stderrErrors.some((e) =>
        stderr.toLowerCase().includes(e)
      )

      if (result.exitCode !== 0 || hasStderrError) {
        const parts: string[] = []
        if (stdout.trim()) parts.push(stdout)
        if (stderr.trim()) parts.push(`stderr:\n${stderr}`)
        const message = parts.length > 0 ? parts.join("\n\n") : "(no output)"
        throw new Error(
          `Command failed with exit code ${result.exitCode}:\n${args.command}\n\n${message}`
        )
      }

      let output = stdout
      if (stderr.trim()) {
        output += "\n\nstderr:\n" + stderr
      }
      if (!output.trim()) {
        output = "(no output)"
      }

      return {
        title: args.description || "bash",
        output,
        metadata: {
          exit: result.exitCode,
          description: args.description,
          stderr: stderr || undefined,
        },
      }
    },
  })
}

const SSH_NOISE_PATTERNS = [
  /^Warning: Permanently added .* to the list of known hosts\.\s*$/,
  /^\*\* WARNING: connection is not using a post-quantum key exchange algorithm\.\s*$/,
  /^\*\* This session may be vulnerable to "store now, decrypt later" attacks\.\s*$/,
  /^\*\* The server may need to be upgraded\. See https:\/\/openssh\.com\/pq\.html\s*$/,
  /^Connection to .* closed\.\s*$/,
]

function filterSshNoise(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => !SSH_NOISE_PATTERNS.some((p) => p.test(line)))
    .join("\n")
}
