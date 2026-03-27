import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Env } from "../../src/env"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Team } from "../../src/team"
import { TeamWorktree } from "../../src/team/worktree"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

async function git(dir: string, args: string[]) {
  const proc = Bun.spawn(["git", "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() }
}

async function member(dir: string, team: string, name: string) {
  const tree = await TeamWorktree.create({
    repoDir: dir,
    teamName: team,
    memberName: name,
    projectID: Instance.project.id,
  })
  if (!tree) throw new Error("expected git worktree")
  await Team.addMember(team, {
    name,
    sessionID: `ses_${name}`,
    agent: "general",
    status: "shutdown",
    worktreePath: tree.path,
    worktreeBranch: tree.branch,
    mergeStatus: "pending",
  })
  return tree
}

describe("team merge", () => {
  test("merge skips empty worktrees", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const lead = await Session.create({})
        await Team.create({ name: "merge-empty", leadSessionID: lead.id, worktrees: true })
        await member(tmp.path, "merge-empty", "worker")

        const result = await Team.merge("merge-empty")
        const team = await Team.get("merge-empty")
        const next = team?.members.find((item) => item.name === "worker")

        expect(result.merged).toEqual([])
        expect(result.skipped).toEqual(["worker"])
        expect(result.conflicts).toEqual([])
        expect(next?.mergeStatus).toBe("skipped")
      },
    })
  })

  test("merge finalizes dirty worktrees and merges them into the lead branch", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, "note.txt"), "base\n")
    await git(tmp.path, ["add", "note.txt"])
    await git(tmp.path, ["commit", "-m", "add note"])

    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const lead = await Session.create({})
        await Team.create({ name: "merge-dirty", leadSessionID: lead.id, worktrees: true })
        const tree = await member(tmp.path, "merge-dirty", "worker")
        await fs.writeFile(path.join(tree.path, "note.txt"), "worker\n")
        await fs.writeFile(path.join(tree.path, "new.txt"), "hello\n")

        const result = await Team.merge("merge-dirty")
        const team = await Team.get("merge-dirty")
        const next = team?.members.find((item) => item.name === "worker")

        expect(result.merged).toEqual(["worker"])
        expect(result.conflicts).toEqual([])
        expect(next?.mergeStatus).toBe("merged")
        expect(await Bun.file(path.join(tmp.path, "note.txt")).text()).toBe("worker\n")
        expect(await Bun.file(path.join(tmp.path, "new.txt")).text()).toBe("hello\n")
        expect((await git(tree.path, ["log", "--format=%s", "-1"])).stdout).toBe("team(merge-dirty): finalize worker")
        expect((await git(tmp.path, ["log", "--format=%s", "-1"])).stdout).toBe("merge(team): merge-dirty/worker")
      },
    })
  })

  test("merge aborts on conflicts and preserves worktrees", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, "note.txt"), "base\n")
    await git(tmp.path, ["add", "note.txt"])
    await git(tmp.path, ["commit", "-m", "add note"])

    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const lead = await Session.create({})
        await Team.create({ name: "merge-conflict", leadSessionID: lead.id, worktrees: true })
        const first = await member(tmp.path, "merge-conflict", "first")
        const second = await member(tmp.path, "merge-conflict", "second")
        await fs.writeFile(path.join(first.path, "note.txt"), "first\n")
        await fs.writeFile(path.join(second.path, "note.txt"), "second\n")

        const result = await Team.merge("merge-conflict")
        const team = await Team.get("merge-conflict")
        const a = team?.members.find((item) => item.name === "first")
        const b = team?.members.find((item) => item.name === "second")

        expect(result.merged).toEqual(["first"])
        expect(result.conflicts).toHaveLength(1)
        expect(result.conflicts[0]?.name).toBe("second")
        expect(a?.mergeStatus).toBe("merged")
        expect(b?.mergeStatus).toBe("conflict")
        expect(b?.mergeError).toContain("note.txt")
        expect(await Bun.file(path.join(tmp.path, "note.txt")).text()).toBe("first\n")
        expect((await git(tmp.path, ["diff", "--name-only", "--diff-filter=U"])).stdout).toBe("")
        expect(await fs.stat(first.path).then(() => true)).toBe(true)
        expect(await fs.stat(second.path).then(() => true)).toBe(true)
      },
    })
  })

  test("cleanup requires merged or skipped worktree members", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const lead = await Session.create({})
        await Team.create({ name: "merge-cleanup", leadSessionID: lead.id, worktrees: true })
        const tree = await member(tmp.path, "merge-cleanup", "worker")

        await expect(Team.cleanup("merge-cleanup")).rejects.toThrow(/team_merge/i)
        await Team.merge("merge-cleanup")
        await Team.cleanup("merge-cleanup")

        expect(
          await fs
            .stat(tree.path)
            .then(() => true)
            .catch(() => false),
        ).toBe(false)
      },
    })
  })
})
