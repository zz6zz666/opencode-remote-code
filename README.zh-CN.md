# 🌐 Remote Code

[English](README.md)

一款 OpenCode 插件，让 AI Agent 能够通过 SSH 直接操控远程机器——**远程端零依赖**，仅需 SSH 守护进程即可。无需在远程安装任何 agent、运行时或依赖。

对 AI 而言，一切感知与本地无异：它调用的仍然是 `bash`、`edit`、`write`、`read`、`glob`、`grep` 和 `apply_patch`。

---

## 💡 为什么需要 Remote Code？

我是一名模拟 IC 工程师。日常工作依赖 **Cadence IC6.1.7 设计套件**，它运行在一台古老的 **CentOS 6 虚拟机**上。CentOS 6 的 glibc 版本无法安装任何现代化 agent 工具，Node.js、Python 3.11+ 甚至大多数现代 CLI 工具都无法运行。

我需要在本地 Windows 主机使用 OpenCode 来操控这台虚拟机——自动化设计流程、批量修改原理图参数、运行仿真脚本。**Remote Code** 让这一切成为可能：AI 以为自己在直接操作本地文件，实际上每个命令都在那台古老的虚拟机上执行。

![pic](pic.png)

**无需触碰虚拟机上的任何一个文件，只需 SSH 服务在运行。**

| 场景                           | 痛点                       | Remote Code 的解法     |
| :----------------------------- | :------------------------- | :--------------------- |
| 老旧虚拟机（CentOS 6、RHEL 5） | 无法安装现代 agent         | 仅需 SSH               |
| 生产服务器                     | 合规严格，禁止随意安装软件 | 远程不留任何痕迹       |
| 嵌入式/边缘设备                | 资源受限，无包管理器       | 所有智能逻辑在本地运行 |
| 远程 Windows 主机              | 只需安装 OpenSSH           | 统一操控入口           |
| 容器/临时环境                  | 不想反复配置               | 即连即用，退出无残留   |

---

## 📋 前置要求

- **OpenCode**（最新版本）
- 远程机器上运行的 **SSH 服务**（**唯一的远程依赖**）

> **注意**：本插件同时提供服务器组件（tools）和 TUI 组件（远程状态指示器）。OpenCode 会自动加载两者。
>
> 本插件内部使用纯 Node.js 的 `ssh2` 库。你**不需要**在本地安装 `ssh`、`sshpass` 或 `rsync`。

---

## 🚀 安装

本插件包含外部依赖且需要构建，**必须从源码安装**。

```bash
# 1. 下载或克隆
git clone https://github.com/zz6zz666/opencode-remote-code.git

# 2. 安装依赖并构建
cd opencode-remote-code
npm install
npm run build
```

构建完成后，选择以下任一方式：

### 方式 A：复制到 OpenCode 插件目录（推荐）

将构建好的插件复制到 OpenCode 插件目录，之后即可删除原始下载：

```bash
# Linux/macOS:
cp -r . ~/.config/opencode/plugins/remote-code

# Windows (PowerShell):
Copy-Item -Recurse -Force . $env:USERPROFILE\.config\opencode\plugins\remote-code
```

> OpenCode 从 `~/.config/opencode/plugins/`（全局）或 `.opencode/plugins/`（项目级）加载本地插件。目录必须包含 `package.json` 和构建好的 `dist/` 文件夹。

### 方式 B：直接引用源码路径（开发用）

保持插件原位，让 OpenCode 直接引用：

```json
{
  "plugin": ["/absolute/path/to/opencode-remote-code"]
}
```

开发时可用 `npm run dev` 监听变更并自动重新构建。

---

## 🎯 使用方式

远程模式**仅通过环境变量激活**。OpenCode CLI 不识别 `--remote*` 参数，且 `opencode.json` 中的 plugin options 会因内部缓存而不可靠。

请创建一个启动脚本，设置所需的环境变量后再调用 `opencode`：

### Windows CMD（`.bat`）

```bat
@echo off
chcp 65001 >nul
set "REMOTE_SSH=ssh -i C:\Users\me\.ssh\id_rsa user@host"
set "REMOTE_WORKDIR=/home/project"
set "REMOTE_PASSWORD=你的密码"
set "REMOTE_SUDO_PASSWORD=你的sudo密码"
opencode %*
```

### Windows PowerShell（`.ps1`）

```powershell
$env:REMOTE_SSH = "ssh -i C:\Users\me\.ssh\id_rsa user@host"
$env:REMOTE_WORKDIR = "/home/project"
$env:REMOTE_PASSWORD = "你的密码"
$env:REMOTE_SUDO_PASSWORD = "你的sudo密码"
opencode @args
```

### Linux / macOS Bash（`.sh`）

```bash
#!/bin/bash
export REMOTE_SSH="ssh -i ~/.ssh/id_rsa user@host"
export REMOTE_WORKDIR="/home/project"
export REMOTE_PASSWORD="你的密码"
export REMOTE_SUDO_PASSWORD="你的sudo密码"
opencode "$@"
```

保存脚本，在 Unix 系统上赋予执行权限，然后用它来启动 OpenCode。

### 配置选项

| 环境变量                 | 说明                                          | 默认值                   |
| :----------------------- | :-------------------------------------------- | :----------------------- |
| `REMOTE_SSH`           | 完整的 SSH 连接命令（与终端输入格式完全一致） | *(必填)*               |
| `REMOTE_WORKDIR`       | 远程工作目录（绝对路径）                      | *(必填)*               |
| `REMOTE_MIRROR`        | 本地镜像根目录                                | `~/.opencode/mirrors/` |
| `REMOTE_PASSWORD`      | SSH 登录密码                                  | *(可选)*               |
| `REMOTE_SUDO_PASSWORD` | 远程命令的 sudo 密码                          | *(可选)*               |

若未设置 `REMOTE_SSH`，插件保持休眠，OpenCode 完全按本地模式运行。

### 认证示例

**密钥认证（推荐）：**

```bat
set "REMOTE_SSH=ssh -i C:\Users\me\.ssh\id_rsa user@host"
set "REMOTE_WORKDIR=/home/project"
```

**密码认证：**

```bat
set "REMOTE_SSH=ssh user@host"
set "REMOTE_WORKDIR=/home/project"
set "REMOTE_PASSWORD=mypassword"
```

**sudo 命令：**

```bat
set "REMOTE_SSH=ssh user@host"
set "REMOTE_WORKDIR=/app"
set "REMOTE_PASSWORD=mypassword"
set "REMOTE_SUDO_PASSWORD=mysudopass"
```

AI 随后可以在 `bash` 命令中自然地使用 `sudo`，不会遇到交互式密码提示。

---

## ⚙️ 工作原理

### 1. 本地镜像

Remote Code **不做全量目录镜像**，只同步 AI 实际触碰过的文件。镜像目录结构：

```
~/.opencode/mirrors/
└── root_192.168.184.135/
    └── home_project/
        ├── manifest.json          # 触碰文件清单
        └── home/project/          # 镜像目录树
            └── src/
                └── main.ts
```

### 2. 路径映射

**AI 看到的所有路径都是远程绝对路径**。插件在后台透明转换：

```
AI 看到:     /home/project/src/main.ts
本地路径:    ~/.opencode/mirrors/root_192.168.184.135/home_project/home/project/src/main.ts
```

### 3. 同步引擎

文件编辑类工具（`read`、`write`、`edit`、`apply_patch`）在本地镜像上操作，通过 SFTP 借助持久 SSH 连接同步：

- **编辑前** → `pullAll()` 确保本地镜像与远程一致
- **编辑后** → `pushAll()` 将修改上传到远程

命令执行类工具（`bash`、`glob`、`grep`）直接通过 SSH 在远程执行。

### 4. SSH 架构

插件使用 `ssh2` 库维护连接池：

- **命令池**（5 个连接）：用于 `bash`、`glob`、`grep` 执行
- **文件池**（3 个连接）：用于 SFTP 文件传输

不需要外部 `ssh`、`sshpass` 或 `rsync` 可执行文件。

---

## 📊 工具行为矩阵

| 工具            | 执行位置 | 同步                     | 说明                                                                |
| :-------------- | :------- | :----------------------- | :------------------------------------------------------------------ |
| `bash`        | 远程 SSH | 无                       | 命令直接转发到远程 shell                                            |
| `glob`        | 远程 SSH | 无                       | 远程 `rg --files --sortr=modified`（fallback 到 `find + stat`） |
| `grep`        | 远程 SSH | 无                       | 远程 `rg --json`（fallback 到 `grep -rn`）                      |
| `read`        | 本地镜像 | 执行前 pull              | 读取已同步的镜像文件                                                |
| `write`       | 本地镜像 | 条件 pull，执行后 push   | 本地写入后上传                                                      |
| `edit`        | 本地镜像 | 执行前 pull，执行后 push | 本地精确替换后上传                                                  |
| `apply_patch` | 本地镜像 | 执行前 pull，执行后 push | 本地应用 patch 后上传                                               |

---

## 🔒 安全边界

- **路径安全**：`PathMapper` 校验本地路径不超出镜像根目录，`../` 穿透会被拒绝。
- **命令安全**：`bash` 工具的动态参数尽量直接通过 SSH 传递，避免本地 shell 插值。
- **权限边界**：远程操作权限与 SSH 用户一致，不提升权限。
- **工作目录**：操作非工作目录内的文件时触发 OpenCode 原生确认流程。

---

## ⚠️ 局限性

| 局限               | 影响                                                             | 缓解                              |
| :----------------- | :--------------------------------------------------------------- | :-------------------------------- |
| 大文件首次访问延迟 | 单个大文件首次下载需等待                                         | 后续 SFTP 仅传差异                |
| 无远程 LSP         | 远程文件无语言服务器诊断                                         | 非基本编辑的必需功能              |
| 远程环境依赖       | `glob`/`grep` 优先远程 `rg`，fallback 到 `find`/`grep` | 绝大多数 Linux 发行版内置         |
| 并发编辑安全       | `edit` 工具带 per-file 锁，同一文件并发编辑自动串行化          | `bash`/`glob`/`grep` 无状态 |
| 二进制文件         | `read` 通过扩展名 + 内容采样检测二进制文件                     | 二进制文件请用 `bash` 工具查看  |
| BOM 处理           | `read`/`write`/`edit`/`patch` 自动保留 UTF-8 BOM         | 完全透明，无需用户干预            |

---

## 📄 许可

MIT
