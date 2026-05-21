import os from "os"
import path from "path"

export interface RemoteConfig {
  /** Raw SSH command string, e.g. "ssh -oHostKeyAlgorithms=+ssh-rsa root@host" */
  sshCommand: string
  /** Parsed SSH target host */
  host: string
  /** Parsed SSH user */
  user: string
  /** Parsed SSH port */
  port: number
  /** Parsed identity file (optional) */
  identity?: string
  /** Extra SSH -o options */
  extraOptions: string[]
  /** SSH login password (optional, uses sshpass) */
  password?: string
  /** Sudo password for remote commands (optional) */
  sudoPassword?: string
  /** Remote working directory (absolute path on remote) */
  remoteWorkdir: string
  /** Local mirror root directory */
  mirrorRoot: string
  /** Whether remote mode is active */
  active: boolean
}

function parseArgv(): Record<string, string | undefined> {
  const args: Record<string, string | undefined> = {}
  const argv = process.argv
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith("--")) {
      const key = arg
      const next = argv[i + 1]
      if (next && !next.startsWith("-")) {
        args[key] = next
        i++
      } else {
        args[key] = "true"
      }
    }
  }
  return args
}

function parseSshCommand(cmd: string): {
  host: string
  user: string
  port: number
  identity?: string
  extraOptions: string[]
} {
  const tokens = cmd.trim().split(/\s+/)
  if (tokens.length === 0 || tokens[0] !== "ssh") {
    throw new Error(`Remote Code: --remote must start with "ssh", got: ${cmd}`)
  }

  let host = ""
  let user = ""
  let port = 22
  let identity: string | undefined
  const extraOptions: string[] = []

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok === "-p" || tok === "--port") {
      port = parseInt(tokens[++i], 10)
      if (isNaN(port)) throw new Error(`Remote Code: invalid port in --remote`)
    } else if (tok === "-i") {
      identity = tokens[++i]
    } else if (tok.startsWith("-o")) {
      // Handle both `-oKey=Value` and `-o Key=Value`
      if (tok === "-o") {
        extraOptions.push("-o", tokens[++i])
      } else {
        extraOptions.push("-o", tok.slice(2))
      }
    } else if (tok.startsWith("-")) {
      // Other flags we don't explicitly parse; if they take args, skip next token heuristically
      // This is best-effort; users with exotic flags should rely on -o
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
        i++
      }
    } else if (tok.includes("@")) {
      const at = tok.lastIndexOf("@")
      user = tok.slice(0, at)
      host = tok.slice(at + 1)
    } else {
      host = tok
    }
  }

  if (!host) {
    throw new Error(`Remote Code: could not parse host from --remote: ${cmd}`)
  }
  if (!user) {
    user = "root"
  }

  return { host, user, port, identity, extraOptions }
}

export function loadConfig(options?: Record<string, unknown>): RemoteConfig | null {
  const args = parseArgv()

  // Remote mode activation: MUST come from CLI args or env vars.
  // Plugin options alone do NOT activate remote mode.
  const hasCliRemote = Boolean(args["--remote"] || args["--remote-ssh"])
  const hasEnvRemote = Boolean(process.env.REMOTE_SSH)

  if (!hasCliRemote && !hasEnvRemote) {
    return null
  }

  // Priority: CLI args > env vars > plugin options (fallback only)
  const opt = (key: string): string | undefined => {
    const legacyKey = key === "ssh" ? "--remote" : `--remote-${key}`
    const cliKey = `--remote-${key}`
    if (args[legacyKey]) return args[legacyKey]
    if (args[cliKey]) return args[cliKey]
    const envKey = key === "ssh" ? "REMOTE_SSH" : `REMOTE_${key.toUpperCase()}`
    const envValue = process.env[envKey]
    if (envValue) return envValue
    // Fallback to plugin options for supplementary config only
    if (options && typeof options[key] === "string") return options[key] as string
    return undefined
  }

  const sshCommand = opt("ssh")
  if (!sshCommand) {
    return null
  }

  const remoteWorkdir = opt("workdir")
  if (!remoteWorkdir) {
    throw new Error(
      `Remote Code: remote SSH is configured but remote-workdir is missing. Provide it via --remote-workdir, plugin options, or REMOTE_WORKDIR env var.`
    )
  }

  const parsed = parseSshCommand(sshCommand)
  const mirrorRoot =
    opt("mirror") ?? path.join(os.homedir(), ".opencode", "mirrors")

  const password = opt("password")
  const sudoPassword = opt("sudo-password")

  return {
    sshCommand,
    ...parsed,
    password,
    sudoPassword,
    remoteWorkdir,
    mirrorRoot,
    active: true,
  }
}
