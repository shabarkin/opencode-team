import fs from "fs/promises"
import path from "path"
import { Global } from "../global"
import { Log } from "../util"
import { git as runGit } from "../util/git"

const log = Log.create({ service: "team.worktree" })

function name(teamName: string, memberName: string, suffix?: string) {
  return suffix ? `team/${teamName}/${memberName}-${suffix}` : `team/${teamName}/${memberName}`
}

function dir(projectID: string, teamName: string, memberName: string, suffix?: string) {
  return path.join(Global.Path.data, "worktrees", projectID, teamName, suffix ? `${memberName}-${suffix}` : memberName)
}

function tag() {
  return `${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`
}

function exists(target: string) {
  return fs
    .stat(target)
    .then(() => true)
    .catch(() => false)
}

async function git(cwd: string, args: string[]) {
  const result = await runGit(args, { cwd })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  }
}

function errorText(result: { stdout: string; stderr: string }) {
  return [result.stderr, result.stdout].filter(Boolean).join("\n")
}

async function prune(dir: string) {
  const result = await git(dir, ["worktree", "prune"])
  if (result.exitCode === 0) return
  throw new Error(errorText(result) || `Failed to prune worktrees in ${dir}.`)
}

export namespace TeamWorktree {
  export async function isGitRepo(dir: string): Promise<boolean> {
    return (await git(dir, ["rev-parse", "--git-dir"])).exitCode === 0
  }

  export async function create(opts: {
    repoDir: string
    teamName: string
    memberName: string
    projectID: string
  }): Promise<{ path: string; branch: string } | null> {
    if (!(await isGitRepo(opts.repoDir))) return null
    await fs.mkdir(path.join(Global.Path.data, "worktrees", opts.projectID, opts.teamName), { recursive: true })

    for (let i = 0; i < 6; i++) {
      const suffix = i === 0 ? undefined : tag()
      const branch = name(opts.teamName, opts.memberName, suffix)
      const worktreePath = dir(opts.projectID, opts.teamName, opts.memberName, suffix)
      const seen = await git(opts.repoDir, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])
      if (seen.exitCode === 0) continue
      await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => undefined)

      const created = await git(opts.repoDir, ["worktree", "add", "-b", branch, worktreePath, "HEAD"])
      if (created.exitCode === 0) {
        return { path: worktreePath, branch }
      }

      const msg = errorText(created)
      if (
        msg.includes("already exists") ||
        msg.includes("already checked out") ||
        msg.includes("already registered") ||
        msg.includes("'HEAD' is already checked out")
      ) {
        continue
      }

      throw new Error(msg || `Failed to create worktree for teammate "${opts.memberName}".`)
    }

    throw new Error(`Failed to create a unique worktree for teammate "${opts.memberName}".`)
  }

  export async function remove(opts: { repoDir: string; worktreePath: string; branch: string }): Promise<void> {
    if (await exists(opts.worktreePath)) {
      const removed = await git(opts.repoDir, ["worktree", "remove", "--force", opts.worktreePath])
      if (removed.exitCode !== 0) {
        throw new Error(errorText(removed) || `Failed to remove worktree ${opts.worktreePath}.`)
      }

      await fs.rm(opts.worktreePath, { recursive: true, force: true }).catch(() => undefined)
    }

    await prune(opts.repoDir)

    let deleted = await git(opts.repoDir, ["branch", "-D", opts.branch])
    if (deleted.exitCode !== 0 && errorText(deleted).includes("used by worktree")) {
      await prune(opts.repoDir)
      deleted = await git(opts.repoDir, ["branch", "-D", opts.branch])
    }
    if (deleted.exitCode === 0) return

    const text = errorText(deleted)
    if (text.includes("not found")) return
    log.warn("worktree branch delete failed", {
      worktreePath: opts.worktreePath,
      branch: opts.branch,
      error: text,
    })
    throw new Error(text || `Failed to delete worktree branch ${opts.branch}.`)
  }

  export async function removeAll(opts: {
    repoDir: string
    entries: Array<{ worktreePath: string; branch: string }>
  }): Promise<void> {
    for (const item of opts.entries) {
      await remove({
        repoDir: opts.repoDir,
        worktreePath: item.worktreePath,
        branch: item.branch,
      })
    }
  }
}
