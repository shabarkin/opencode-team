import fs from "fs/promises"
import { Instance } from "@/project/instance"
import { Storage } from "@/storage/storage"
import { Log } from "@/util"
import type { TeamInfo, TeamMember } from "./events"

const log = Log.create({ service: "team.merge" })

const mail = "team@opencode.local"
const user = "OpenCode Team"

type Conflict = {
  name: string
  error: string
  files: string[]
}

export type Action = "merge" | "continue" | "abort" | "mark_resolved"

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

function mergeMsg(teamName: string, memberName: string) {
  return `merge(team): ${teamName}/${memberName}`
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

async function merging(dir: string) {
  return (await git(dir, ["rev-parse", "--verify", "MERGE_HEAD"])).exitCode === 0
}

function conflict(team: TeamInfo, name?: string) {
  if (name) return team.members.find((member) => member.name === name && member.worktreeBranch)
  const list = team.members.filter((member) => member.mergeStatus === "conflict" && member.worktreeBranch)
  if (list.length > 1) throw new Error("Multiple teammate conflicts are recorded. Resolve them one at a time.")
  return list[0]
}

async function merged(teamName: string, member: TeamMember) {
  await update(teamName, member.name, {
    mergeStatus: "merged",
    mergeError: undefined,
    mergedAt: Date.now(),
  })
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

  const result = await git(repoDir, ["merge", "--no-ff", "--no-commit", member.worktreeBranch!])
  if (result.exitCode !== 0) {
    const list = await files(repoDir)
    if (list.length) {
      const error = msg(result) || `Merge conflict for ${member.name}.`
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
    throw new Error(msg(result) || `Failed to merge ${member.name}.`)
  }

  const committed = await git(repoDir, ["commit", "-m", mergeMsg(teamName, member.name)], commitEnv())
  if (committed.exitCode !== 0) {
    await git(repoDir, ["merge", "--abort"])
    throw new Error(msg(committed) || `Failed to commit merge for ${member.name}.`)
  }

  await merged(teamName, member)
  return { kind: "merged" as const }
}

async function continued(team: TeamInfo, repoDir: string, memberName?: string): Promise<Result> {
  const member = conflict(team, memberName)
  if (!member?.worktreeBranch) {
    throw new Error(
      memberName
        ? `Teammate "${memberName}" does not have a recorded merge conflict.`
        : "No conflicted teammate merge is in progress.",
    )
  }

  if (!(await merging(repoDir))) {
    if ((await ahead(repoDir, member.worktreeBranch)) === 0) {
      await merged(team.name, member)
      return { merged: [member.name], skipped: [], conflicts: [], pending: [] }
    }
    throw new Error(`No merge is in progress for "${member.name}". Rerun team_merge or use action=mark_resolved.`)
  }

  const list = await files(repoDir)
  if (list.length > 0) {
    throw new Error(`Merge for "${member.name}" still has unresolved files: ${list.join(", ")}.`)
  }

  const committed = await git(repoDir, ["commit", "-m", mergeMsg(team.name, member.name)], commitEnv())
  if (committed.exitCode !== 0) {
    throw new Error(msg(committed) || `Failed to commit merge for ${member.name}.`)
  }

  await merged(team.name, member)
  return { merged: [member.name], skipped: [], conflicts: [], pending: [] }
}

async function aborted(team: TeamInfo, repoDir: string, memberName?: string): Promise<Result> {
  const member = conflict(team, memberName)
  if (!(await merging(repoDir))) {
    return { merged: [], skipped: [], conflicts: [], pending: member?.name ? [member.name] : [] }
  }

  const result = await git(repoDir, ["merge", "--abort"])
  if (result.exitCode !== 0) {
    throw new Error(msg(result) || "Failed to abort merge.")
  }

  return { merged: [], skipped: [], conflicts: [], pending: member?.name ? [member.name] : [] }
}

async function marked(team: TeamInfo, repoDir: string, memberName?: string): Promise<Result> {
  const member = conflict(team, memberName)
  if (!member?.worktreeBranch) {
    throw new Error(
      memberName
        ? `Teammate "${memberName}" does not have a mergeable worktree branch.`
        : "Choose a conflicted teammate to mark resolved.",
    )
  }
  if (await merging(repoDir)) {
    throw new Error(`A merge is still in progress for "${member.name}". Use action=continue or action=abort first.`)
  }
  if (!(await clean(repoDir))) {
    throw new Error(
      "Lead workspace has uncommitted changes. Commit, stash, or clean it before marking a merge resolved.",
    )
  }

  if ((await ahead(repoDir, member.worktreeBranch)) !== 0) {
    const result = await git(
      repoDir,
      ["merge", "-s", "ours", "--no-ff", "-m", mergeMsg(team.name, member.name), member.worktreeBranch],
      commitEnv(),
    )
    if (result.exitCode !== 0) {
      throw new Error(msg(result) || `Failed to record resolved merge for ${member.name}.`)
    }
  }

  await merged(team.name, member)
  return { merged: [member.name], skipped: [], conflicts: [], pending: [] }
}

export namespace TeamMerge {
  export async function merge(input: {
    team: TeamInfo
    repoDir: string
    memberName?: string
    action?: Action
  }): Promise<Result> {
    const action = input.action ?? "merge"
    if (action === "continue") return continued(input.team, input.repoDir, input.memberName)
    if (action === "abort") return aborted(input.team, input.repoDir, input.memberName)
    if (action === "mark_resolved") return marked(input.team, input.repoDir, input.memberName)

    if (await merging(input.repoDir)) {
      throw new Error(
        "A teammate merge is already in progress. Resolve it, then use team_merge with action=continue or action=abort.",
      )
    }
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

    const mergedNames = new Set([...result.merged, ...result.skipped, ...result.conflicts.map((item) => item.name)])
    const rest = list
      .filter((member) => member.worktreeBranch)
      .map((member) => member.name)
      .filter((name) => !mergedNames.has(name))
    result.pending.push(...rest.filter((name) => !result.pending.includes(name)))
    return result
  }
}
