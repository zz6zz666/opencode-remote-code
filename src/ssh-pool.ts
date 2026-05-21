import { Client, type SFTPWrapper } from "ssh2"
import { readFileSync } from "fs"
import type { RemoteConfig } from "./config.js"

export interface SSHPool {
  exec(command: string, options?: { cwd?: string; timeout?: number }): Promise<{
    stdout: string
    stderr: string
    exitCode: number
  }>
  withSftp<T>(fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T>
  getSudoAskpassPath(): string | undefined
  close(): Promise<void>
}

const HEALTH_CHECK_INTERVAL_MS = 30_000
const HEALTH_CHECK_TIMEOUT_MS = 5_000
const RETRY_DELAY_MS = 500
const CONNECTION_RETRY_DELAY_MS = 5_000

class ConnectionPool {
  private clients: Client[] = []
  private busy = new Set<Client>()
  private queue: Array<(client: Client) => void> = []
  private healthTimer?: NodeJS.Timeout
  private destroyed = false
  private replenishing = false
  ready: Promise<void>

  constructor(
    private config: RemoteConfig,
    private size: number,
    private staggerMs: number = 0
  ) {
    this.ready = this.init()
    this.startHealthCheck()
  }

  private async init(): Promise<void> {
    // Sequential creation with optional stagger to avoid overwhelming legacy SSH servers
    for (let i = 0; i < this.size; i++) {
      await this.createClient()
      if (this.staggerMs > 0 && i < this.size - 1) {
        await new Promise((r) => setTimeout(r, this.staggerMs))
      }
    }
  }

  private createClient(): Promise<void> {
    const CREATE_TIMEOUT_MS = 30_000
    return new Promise((resolve, reject) => {
      const client = new Client()
      let resolved = false
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true
          client.end()
          reject(new Error(`SSH connection timeout after ${CREATE_TIMEOUT_MS}ms`))
        }
      }, CREATE_TIMEOUT_MS)

      const connConfig: any = {
        host: this.config.host,
        port: this.config.port,
        username: this.config.user,
        readyTimeout: 20_000,
        keepaliveInterval: 10_000,
        keepaliveCountMax: 3,
        algorithms: buildAlgorithms(this.config.extraOptions),
      }

      // Parse extra -o options
      for (let i = 0; i < this.config.extraOptions.length; i++) {
        const opt = this.config.extraOptions[i]
        if (opt === "StrictHostKeyChecking" && this.config.extraOptions[i + 1] === "no") {
          connConfig.hostVerifier = () => true
          i++
        }
      }

      if (this.config.identity) {
        connConfig.privateKey = readFileSync(this.config.identity)
      } else if (this.config.password) {
        connConfig.password = this.config.password
      }

      client
        .on("ready", () => {
          if (!resolved) {
            resolved = true
            clearTimeout(timer)
            this.clients.push(client)
            resolve()
          }
        })
        .on("error", (err: Error) => {
          if (!resolved) {
            resolved = true
            clearTimeout(timer)
            reject(err)
          } else {
            this.removeClient(client)
            client.end()
          }
        })
        .on("close", () => {
          this.removeClient(client)
          this.processQueue()
        })

      client.connect(connConfig)
    })
  }

  private removeClient(client: Client): void {
    this.clients = this.clients.filter((c) => c !== client)
    this.busy.delete(client)
  }

  private processQueue(): void {
    while (this.queue.length > 0) {
      const free = this.clients.find((c) => !this.busy.has(c))
      if (!free) break
      const next = this.queue.shift()
      if (next) {
        this.busy.add(free)
        next(free)
      }
    }
  }

  private startHealthCheck(): void {
    this.healthTimer = setInterval(() => {
      if (this.destroyed) return
      this.checkHealth().catch(() => {})
    }, HEALTH_CHECK_INTERVAL_MS)
  }

  private async checkHealth(): Promise<void> {
    // 1. Replenish missing connections
    await this.replenish()

    // 2. Ping idle connections to verify they are responsive
    const idleClients = this.clients.filter((c) => !this.busy.has(c))
    for (const client of idleClients) {
      try {
        await this.pingClient(client)
      } catch {
        console.log(
          `[SSHPool] Health check: unresponsive connection replaced (${this.config.host}:${this.config.port})`
        )
        this.removeClient(client)
        client.end()
        await this.replenishOne()
      }
    }
  }

  private async replenish(): Promise<void> {
    if (this.replenishing) return
    if (this.clients.length >= this.size) return

    this.replenishing = true
    try {
      while (this.clients.length < this.size && !this.destroyed) {
        try {
          await this.createClient()
        } catch (err) {
          console.error(
            `[SSHPool] Failed to create replacement connection: ${(err as Error).message}`
          )
          await new Promise((r) => setTimeout(r, CONNECTION_RETRY_DELAY_MS))
        }
      }
    } finally {
      this.replenishing = false
    }
  }

  private async replenishOne(): Promise<void> {
    if (this.clients.length >= this.size || this.destroyed) return
    try {
      await this.createClient()
    } catch (err) {
      console.error(
        `[SSHPool] Failed to replace connection: ${(err as Error).message}`
      )
    }
  }

  private pingClient(client: Client): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Health check ping timeout"))
      }, HEALTH_CHECK_TIMEOUT_MS)

      client.exec("echo __SSH_HEALTH_CHECK__", (err, stream) => {
        if (err) {
          clearTimeout(timer)
          reject(err)
          return
        }

        let output = ""
        const cleanup = () => clearTimeout(timer)

        stream
          .on("data", (data: Buffer) => {
            output += data.toString("utf-8")
          })
          .on("close", () => {
            cleanup()
            if (output.trim() === "__SSH_HEALTH_CHECK__") {
              resolve()
            } else {
              reject(new Error("Health check ping response invalid"))
            }
          })
          .on("error", (err: Error) => {
            cleanup()
            reject(err)
          })
      })
    })
  }

  async acquire(): Promise<Client> {
    await this.ready
    if (this.destroyed) throw new Error("Connection pool destroyed")

    // Opportunistically replenish if pool is undersized
    if (this.clients.length < this.size) {
      this.replenish().catch(() => {})
    }

    const free = this.clients.find((c) => !this.busy.has(c))
    if (free) {
      this.busy.add(free)
      return free
    }

    return new Promise((resolve) => {
      this.queue.push((client) => resolve(client))
    })
  }

  release(client: Client): void {
    this.busy.delete(client)
    this.processQueue()
  }

  /** Evict a problematic connection and trigger replacement. */
  evictAndReplace(client: Client): void {
    this.removeClient(client)
    client.end()
    this.replenishOne().catch(() => {})
  }

  async close(): Promise<void> {
    this.destroyed = true
    if (this.healthTimer) {
      clearInterval(this.healthTimer)
      this.healthTimer = undefined
    }
    for (const client of this.clients) {
      client.end()
    }
    this.clients = []
    this.busy.clear()
    this.queue = []
  }
}

export async function createSSHPool(config: RemoteConfig): Promise<SSHPool> {
  const commandPoolSize = parseInt(process.env.REMOTE_POOL_COMMAND_SIZE || "3", 10)
  const filePoolSize = parseInt(process.env.REMOTE_POOL_FILE_SIZE || "2", 10)
  const staggerMs = parseInt(process.env.REMOTE_POOL_STAGGER_MS || "0", 10)
  const commandPool = new ConnectionPool(config, commandPoolSize, staggerMs)
  const filePool = new ConnectionPool(config, filePoolSize, staggerMs)
  await Promise.all([commandPool.ready, filePool.ready])

  // Setup sudo askpass on remote if needed
  let sudoAskpassPath: string | undefined
  if (config.sudoPassword) {
    const mktempResult = await execOnPool(
      commandPool,
      "mktemp /tmp/.opencode_sudo_askpass_XXXXXX"
    )
    sudoAskpassPath = mktempResult.stdout.trim()
    const escaped = config.sudoPassword.replace(/'/g, "'\"'\"'")
    await execOnPool(
      commandPool,
      `cat > ${quoteShell(sudoAskpassPath)} << 'EOF'\n#!/bin/sh\necho '${escaped}'\nEOF\nchmod 700 ${quoteShell(sudoAskpassPath)}`
    )
  }

  return {
    async exec(command, options = {}) {
      let shellCommand = command
      if (options.cwd) {
        shellCommand = `cd ${quoteShell(options.cwd)} && ${command}`
      }
      if (sudoAskpassPath && shellCommand.includes("sudo ")) {
        shellCommand = `SUDO_ASKPASS=${quoteShell(sudoAskpassPath)} ${shellCommand.replace(
          /\bsudo\b/g,
          "sudo -A"
        )}`
      }
      return execOnPool(commandPool, shellCommand, options.timeout)
    },

    async withSftp<T>(fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
      const client = await filePool.acquire()
      try {
        return await new Promise<T>((resolve, reject) => {
          client.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
            if (err) {
              reject(err)
              return
            }
            fn(sftp)
              .then((result) => {
                sftp.end()
                resolve(result)
              })
              .catch((err) => {
                sftp.end()
                reject(err)
              })
          })
        })
      } finally {
        filePool.release(client)
      }
    },

    getSudoAskpassPath(): string | undefined {
      return sudoAskpassPath
    },

    async close() {
      if (sudoAskpassPath) {
        await execOnPool(commandPool, `rm -f ${sudoAskpassPath}`).catch(() => {})
      }
      await Promise.all([commandPool.close(), filePool.close()])
    },
  }
}

async function execOnPool(
  pool: ConnectionPool,
  command: string,
  timeoutMs?: number
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let lastError: Error | undefined

  for (let attempt = 0; attempt < 2; attempt++) {
    const client = await pool.acquire()
    try {
      return await execOnClient(client, command, timeoutMs)
    } catch (err) {
      lastError = err as Error
      const isConnError = isConnectionError(lastError)

      if (isConnError) {
        console.log(
          `[SSHPool] Connection error on attempt ${attempt + 1}: ${lastError.message}`
        )
        pool.evictAndReplace(client)
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
          continue
        }
      }

      throw lastError
    } finally {
      pool.release(client)
    }
  }

  throw lastError!
}

async function execOnClient(
  client: Client,
  command: string,
  timeoutMs?: number
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    let killed = false

    const timer =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            if (!killed) {
              killed = true
              reject(new Error(`Remote Code: SSH exec timeout after ${timeoutMs}ms`))
            }
          }, timeoutMs)
        : undefined

    client.exec(command, (err: Error | undefined, stream: any) => {
      if (err) {
        if (timer) clearTimeout(timer)
        reject(err)
        return
      }

      stream
        .on("data", (data: Buffer) => {
          stdout += data.toString("utf-8")
        })
        .stderr.on("data", (data: Buffer) => {
          stderr += data.toString("utf-8")
        })
        .on("close", (code: number, signal: string) => {
          if (timer) clearTimeout(timer)
          if (killed) return
          resolve({
            stdout,
            stderr,
            exitCode: code ?? 0,
          })
        })
        .on("error", (err: Error) => {
          if (timer) clearTimeout(timer)
          if (killed) return
          reject(err)
        })
    })
  })
}

function isConnectionError(err: Error): boolean {
  const msg = err.message.toLowerCase()
  return (
    msg.includes("connection") ||
    msg.includes("socket") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("enotconn") ||
    msg.includes("broken pipe") ||
    msg.includes("no response from server") ||
    msg.includes("connection lost") ||
    msg.includes("connection reset") ||
    msg.includes("network") ||
    msg.includes("disconnected")
  )
}

import { quoteShell } from "./shell-quote.js"

/**
 * Build ssh2 algorithms config from OpenSSH -o options.
 * CentOS 6 and other legacy systems need ssh-rsa (SHA-1) enabled.
 */
function buildAlgorithms(extraOptions: string[]): any {
  const serverHostKey = [
    "ssh-ed25519",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "rsa-sha2-512",
    "rsa-sha2-256",
    "ssh-rsa",
  ]

  // Parse HostKeyAlgorithms from extraOptions
  // Format: extraOptions = ["-o", "HostKeyAlgorithms=+ssh-rsa", ...]
  for (let i = 0; i < extraOptions.length; i++) {
    const opt = extraOptions[i]
    if (opt.startsWith("HostKeyAlgorithms=")) {
      const value = opt.slice("HostKeyAlgorithms=".length)
      if (value.startsWith("+")) {
        const algo = value.slice(1)
        if (!serverHostKey.includes(algo)) {
          serverHostKey.push(algo)
        }
      } else {
        // Replace entire list
        return { serverHostKey: value.split(",") }
      }
    }
  }

  return { serverHostKey }
}
