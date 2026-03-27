import fs from "fs/promises"
import { Instance } from "@/project/instance"
import { Storage } from "@/storage/storage"
import { Log } from "@/util/log"
import type { TeamInfo, TeamMember } from "./events"

const log = Log.create({ service: "team.merge" })

const mail = "team@opencode.local"
const user = "OpenCode Team"

type Conflict = {
  name: string
  error: string
  files: string[]
}

export type Result = {
  merged: string[]
  skipped: string[]
  conflicts: Conflict[]
  pending: string[]
}

function key(name: string) {
  return ["team", Instance.project.id, name]
}

async function git(cwd: string, args: string[], env?: Record<string, string>) {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    env: env ? { ...process.env, ...env } : undefined,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return {
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  }
}

function msg(result: { stdout: string; stderr: string }) {
  return [result.stderr, result.stdout].filter(Boolean).join("\n")
}

function commitEnv() {
  return {
    GIT_AUTHOR_NAME: user,
    GIT_AUTHOR_EMAIL: mail,
    GIT_COMMITTER_NAME: user,
    GIT_COMMITTER_EMAIL: mail,
  }
}

function mergeable(member: TeamMember) {
  return ["ready", "shutdown", "error"].includes(member.status)
}

async function exists(dir: string) {
  return fs
    .stat(dir)
    .then(() => true)
    .catch(() => false)
}

async function update(teamName: string, name: string, input: Partial<TeamMember>) {
  await Storage.update<TeamInfo>(key(teamName), (draft) => {
    const member = draft.members.find((item) => item.name === name)
    if (!member) return
    Object.assign(member, input)
    member.updated = Date.now()
  })
}

async function clean(dir: string) {
  const result = await git(dir, ["status", "--porcelain"])
  if (result.exitCode !== 0) throw new Error(msg(result) || `Failed to inspect ${dir}.`)
  return result.stdout.length === 0
}

async function dirty(dir: string) {
  return !(await clean(dir))
}

async function ahead(dir: string, branch: string) {
  const result = await git(dir, ["rev-list", "--count", `HEAD..${branch}`])
  if (result.exitCode !== 0) throw new Error(msg(result) || `Failed to inspect branch ${branch}.`)
  return Number(result.stdout || "0")
}

async function files(dir: string) {
  const result = await git(dir, ["diff", "--name-only", "--diff-filter=U"])
  if (result.exitCode !== 0) return []
  return result.stdout
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
}

async function finalize(teamName: string, member: TeamMember) {
  if (!member.worktreePath) return
  if (!(await exists(member.worktreePath))) return
  if (!(await dirty(member.worktreePath))) return
  const added = await git(member.worktreePath, ["add", "-A"])
  if (added.exitCode !== 0) throw new Error(msg(added) || `Failed to stage ${member.name}.`)
  const committed = await git(
    member.worktreePath,
    ["commit", "-m", `team(${teamName}): finalize ${member.name}`],
    commitEnv(),
  )
  const text = msg(committed)
  if (committed.exitCode === 0 || text.includes("nothing to commit")) return
  throw new Error(text || `Failed to finalize ${member.name}.`)
}

async function mergeOne(teamName: string, repoDir: string, member: TeamMember) {
  await finalize(teamName, member)
  const count = await ahead(repoDir, member.worktreeBranch!)
  if (count === 0) {
    if (member.mergeStatus !== "merged") {
      await update(teamName, member.name, {
        mergeStatus: "skipped",
        mergeError: undefined,
      })
    }
    return { kind: "skipped" as const }
  }

  const merged = await git(repoDir, ["merge", "--no-ff", "--no-commit", member.worktreeBranch!])
  if (merged.exitCode !== 0) {
    const list = await files(repoDir)
    if (list.length) {
      await git(repoDir, ["merge", "--abort"])
      const error = msg(merged) || `Merge conflict for ${member.name}.`
      await update(teamName, member.name, {
        mergeStatus: "conflict",
        mergeError: [error, ...list].join("\n"),
      })
      return {
        kind: "conflict" as const,
        conflict: {
          name: member.name,
          error,
          files: list,
        },
      }
    }
    throw new Error(msg(merged) || `Failed to merge ${member.name}.`)
  }

  const committed = await git(repoDir, ["commit", "-m", `merge(team): ${teamName}/${member.name}`], commitEnv())
  if (committed.exitCode !== 0) {
    await git(repoDir, ["merge", "--abort"])
    throw new Error(msg(committed) || `Failed to commit merge for ${member.name}.`)
  }

  await update(teamName, member.name, {
    mergeStatus: "merged",
    mergeError: undefined,
    mergedAt: Date.now(),
  })
  return { kind: "merged" as const }
}

export namespace TeamMerge {
  export async function merge(input: { team: TeamInfo; repoDir: string; memberName?: string }): Promise<Result> {
    if (!(await clean(input.repoDir))) {
      throw new Error("Lead workspace has uncommitted changes. Commit, stash, or clean it before team_merge.")
    }

    const list = input.memberName
      ? input.team.members.filter((member) => member.name === input.memberName)
      : input.team.members.filter((member) => member.worktreePath && member.worktreeBranch)
    if (!list.length) {
      if (input.memberName) throw new Error(`Teammate "${input.memberName}" not found.`)
      return { merged: [], skipped: [], conflicts: [], pending: [] }
    }
    if (input.memberName && !list[0]?.worktreeBranch) {
      throw new Error(`Teammate "${input.memberName}" does not have a worktree branch to merge.`)
    }

    const result: Result = {
      merged: [],
      skipped: [],
      conflicts: [],
      pending: [],
    }

    for (const member of list) {
      if (!member.worktreeBranch) continue
      if (!mergeable(member)) {
        if (input.memberName) {
          throw new Error(
            `Teammate "${member.name}" is ${member.status}. Only ready, shutdown, or error teammates can be merged.`,
          )
        }
        result.pending.push(member.name)
        continue
      }
      const next = await mergeOne(input.team.name, input.repoDir, member)
      if (next.kind === "merged") {
        result.merged.push(member.name)
        continue
      }
      if (next.kind === "skipped") {
        result.skipped.push(member.name)
        continue
      }
      result.conflicts.push(next.conflict)
      log.warn("merge conflict", {
        teamName: input.team.name,
        memberName: member.name,
        files: next.conflict.files,
      })
      break
    }

    const merged = new Set([...result.merged, ...result.skipped, ...result.conflicts.map((item) => item.name)])
    const rest = list
      .filter((member) => member.worktreeBranch)
      .map((member) => member.name)
      .filter((name) => !merged.has(name))
    result.pending.push(...rest.filter((name) => !result.pending.includes(name)))
    return result
  }
}
