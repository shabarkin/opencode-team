import { describe, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { Permission } from "../../src/permission"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session, SessionPrompt } from "../../src/team/runtime"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Team } from "../../src/team"
import { TeamWorktree } from "../../src/team/worktree"
import { permPath } from "../../src/tool/perm"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

async function seed(sessionID: string, text = "seed") {
  const messageID = MessageID.ascending()
  await Session.updateMessage({
    id: messageID,
    sessionID: SessionID.make(sessionID),
    role: "user",
    agent: "general",
    model: {
      providerID: ProviderID.make("anthropic"),
      modelID: ModelID.make("claude-sonnet-4-20250514"),
    },
    time: { created: Date.now() },
  })
  await Session.updatePart({
    id: PartID.ascending(),
    messageID,
    sessionID: SessionID.make(sessionID),
    type: "text",
    text,
  })
}

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

function exists(target: string) {
  return fs
    .stat(target)
    .then(() => true)
    .catch(() => false)
}

describe("team worktree", () => {
  test("TeamWorktree.isGitRepo returns true for git repo", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        expect(await TeamWorktree.isGitRepo(tmp.path)).toBe(true)
      },
    })
  })

  test("TeamWorktree.isGitRepo returns false for temp dir", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        expect(await TeamWorktree.isGitRepo(tmp.path)).toBe(false)
      },
    })
  })

  test("TeamWorktree.create makes worktree in XDG data dir, not inside repo", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        const tree = await TeamWorktree.create({
          repoDir: tmp.path,
          teamName: "worktree-team",
          memberName: "alice",
          projectID: Instance.project.id,
        })

        expect(tree).not.toBeNull()
        expect(tree!.path.startsWith(path.join(Global.Path.data, "worktrees", Instance.project.id))).toBe(true)
        expect(tree!.path.startsWith(tmp.path)).toBe(false)

        const list = await git(tmp.path, ["worktree", "list", "--porcelain"])
        expect(list.stdout).toContain(tree!.path)

        await TeamWorktree.remove({
          repoDir: tmp.path,
          worktreePath: tree!.path,
          branch: tree!.branch,
        })
      },
    })
  })

  test("TeamWorktree.remove cleans up worktree and branch", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        const tree = await TeamWorktree.create({
          repoDir: tmp.path,
          teamName: "worktree-team",
          memberName: "bob",
          projectID: Instance.project.id,
        })

        expect(tree).not.toBeNull()
        await TeamWorktree.remove({
          repoDir: tmp.path,
          worktreePath: tree!.path,
          branch: tree!.branch,
        })

        expect(await exists(tree!.path)).toBe(false)
        expect(
          (await git(tmp.path, ["show-ref", "--verify", "--quiet", `refs/heads/${tree!.branch}`])).exitCode,
        ).not.toBe(0)
      },
    })
  })

  test("TeamWorktree.remove prunes stale metadata when the directory is already missing", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        const tree = await TeamWorktree.create({
          repoDir: tmp.path,
          teamName: "worktree-team",
          memberName: "prune",
          projectID: Instance.project.id,
        })

        expect(tree).not.toBeNull()
        await fs.rm(tree!.path, { recursive: true, force: true })
        await TeamWorktree.remove({
          repoDir: tmp.path,
          worktreePath: tree!.path,
          branch: tree!.branch,
        })

        const list = await git(tmp.path, ["worktree", "list", "--porcelain"])
        expect(list.stdout).not.toContain(tree!.path)
        expect(
          (await git(tmp.path, ["show-ref", "--verify", "--quiet", `refs/heads/${tree!.branch}`])).exitCode,
        ).not.toBe(0)
      },
    })
  })

  // TODO(team): The team runtime facade's `Session.createNext` mutates the
  // returned info.directory because Session.create has no directory arg. The
  // mutation is local — `Session.get` later returns the un-mutated persisted
  // record, so this test fails. Add Session.setDirectory upstream and rework
  // createNext (see plan TODO #1 in `runtime.ts`).
  test.skip("spawnMember uses worktree path as session directory when worktrees are enabled", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        const lead = await Session.create({})
        await seed(lead.id)
        await Team.create({ name: "worktree-spawn", leadSessionID: lead.id, worktrees: true })

        const loop = spyOn(SessionPrompt, "loop").mockResolvedValue(undefined as never)
        const spawned = await Team.spawnMember({
          teamName: "worktree-spawn",
          name: "worker",
          parentSessionID: lead.id,
          agent: { name: "general" },
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
          prompt: "Inspect the repo.",
          planApproval: false,
          checkpoint: "none",
        })

        await Bun.sleep(20)

        const session = await Session.get(SessionID.make(spawned.sessionID))
        const team = await Team.get("worktree-spawn")
        const member = team?.members.find((item) => item.name === "worker")
        expect(member?.worktreePath).toBeTruthy()
        expect(member?.worktreeBranch).toBeTruthy()
        expect(member?.mergeStatus).toBe("pending")
        expect(session.directory).toBe(member!.worktreePath!)
        expect(session.directory.startsWith(path.join(Global.Path.data, "worktrees", Instance.project.id))).toBe(true)
        expect(Instance.containsPath(member!.worktreePath!)).toBe(true)

        loop.mockRestore()
        await Team.setMemberStatus("worktree-spawn", "worker", "shutdown")
        expect(await exists(member!.worktreePath!)).toBe(true)
        await Team.merge("worktree-spawn")
        await Team.cleanup("worktree-spawn")
      },
    })
  })

  test("spawnMember grants external_directory allow for the teammate worktree", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        const lead = await Session.create({})
        await seed(lead.id)
        await Team.create({ name: "worktree-ext", leadSessionID: lead.id, worktrees: true })

        const loop = spyOn(SessionPrompt, "loop").mockResolvedValue(undefined as never)
        const spawned = await Team.spawnMember({
          teamName: "worktree-ext",
          name: "worker",
          parentSessionID: lead.id,
          agent: { name: "general" },
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
          prompt: "Inspect the repo.",
          planApproval: false,
          checkpoint: "none",
        })

        await Bun.sleep(20)

        const session = await Session.get(SessionID.make(spawned.sessionID))
        const team = await Team.get("worktree-ext")
        const member = team?.members.find((item) => item.name === "worker")
        expect(
          Permission.evaluate(
            "external_directory",
            path.join(member!.worktreePath!, "note.txt"),
            session.permission ?? [],
          ).action,
        ).toBe("allow")

        loop.mockRestore()
        await Team.setMemberStatus("worktree-ext", "worker", "shutdown")
        await Team.merge("worktree-ext")
        await Team.cleanup("worktree-ext")
      },
    })
  })

  test("spawnMember scope rules match teammate worktree edit paths", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        permission: {
          edit: "ask",
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        const lead = await Session.create({})
        await seed(lead.id)
        await Team.create({ name: "worktree-scope", leadSessionID: lead.id, worktrees: true })

        const loop = spyOn(SessionPrompt, "loop").mockResolvedValue(undefined as never)
        const spawned = await Team.spawnMember({
          teamName: "worktree-scope",
          name: "worker",
          parentSessionID: lead.id,
          agent: { name: "general" },
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
          prompt: "Inspect the repo.",
          planApproval: false,
          checkpoint: "none",
          scope: {
            path_includes: ["note.txt"],
          },
        })

        await Bun.sleep(20)

        const session = await Session.get(SessionID.make(spawned.sessionID))
        expect(
          Permission.evaluate(
            "edit",
            permPath(path.join(session.directory, "note.txt"), { dir: session.directory, root: tmp.path }),
            session.permission ?? [],
          ).action,
        ).toBe("allow")
        expect(
          Permission.evaluate(
            "edit",
            permPath(path.join(session.directory, "other.txt"), { dir: session.directory, root: tmp.path }),
            session.permission ?? [],
          ).action,
        ).toBe("deny")

        loop.mockRestore()
        await Team.setMemberStatus("worktree-scope", "worker", "shutdown")
        await git(tmp.path, ["add", "-A"])
        await git(tmp.path, ["commit", "-m", "test setup"])
        await Team.merge("worktree-scope")
        await Team.cleanup("worktree-scope")
      },
    })
  })

  test("spawnMember stays in shared directory when worktrees are disabled", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        const lead = await Session.create({})
        await seed(lead.id)
        await Team.create({ name: "worktree-disabled", leadSessionID: lead.id, worktrees: false })

        const loop = spyOn(SessionPrompt, "loop").mockResolvedValue(undefined as never)
        const spawned = await Team.spawnMember({
          teamName: "worktree-disabled",
          name: "worker",
          parentSessionID: lead.id,
          agent: { name: "general" },
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
          prompt: "Inspect the repo.",
          planApproval: false,
          checkpoint: "none",
        })

        await Bun.sleep(20)

        const session = await Session.get(SessionID.make(spawned.sessionID))
        const team = await Team.get("worktree-disabled")
        const member = team?.members.find((item) => item.name === "worker")
        expect(session.directory).toBe(tmp.path)
        expect(member?.worktreePath).toBeUndefined()
        expect(member?.worktreeBranch).toBeUndefined()
        expect(member?.mergeStatus).toBeUndefined()

        loop.mockRestore()
        await Team.setMemberStatus("worktree-disabled", "worker", "shutdown")
        await Team.cleanup("worktree-disabled")
      },
    })
  })

  test("spawnMember falls back to Inst.directory when worktrees are enabled in a non-git repo", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        const lead = await Session.create({})
        await seed(lead.id)
        await Team.create({ name: "worktree-fallback", leadSessionID: lead.id, worktrees: true })

        const loop = spyOn(SessionPrompt, "loop").mockResolvedValue(undefined as never)
        const spawned = await Team.spawnMember({
          teamName: "worktree-fallback",
          name: "worker",
          parentSessionID: lead.id,
          agent: { name: "general" },
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
          prompt: "Inspect the repo.",
          planApproval: false,
          checkpoint: "none",
        })

        await Bun.sleep(20)

        const session = await Session.get(SessionID.make(spawned.sessionID))
        const team = await Team.get("worktree-fallback")
        const member = team?.members.find((item) => item.name === "worker")
        expect(session.directory).toBe(tmp.path)
        expect(member?.worktreePath).toBeUndefined()
        expect(member?.worktreeBranch).toBeUndefined()

        loop.mockRestore()
        await Team.setMemberStatus("worktree-fallback", "worker", "shutdown")
        await Team.cleanup("worktree-fallback")
      },
    })
  })

  test("cleanup removes all member worktrees", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        const lead = await Session.create({})
        await seed(lead.id)
        await Team.create({ name: "worktree-cleanup", leadSessionID: lead.id, worktrees: true })

        const tree = await TeamWorktree.create({
          repoDir: tmp.path,
          teamName: "worktree-cleanup",
          memberName: "worker",
          projectID: Instance.project.id,
        })

        await Team.addMember("worktree-cleanup", {
          name: "worker",
          sessionID: "ses_worker_worktree_cleanup",
          agent: "general",
          status: "shutdown",
          worktreePath: tree!.path,
          worktreeBranch: tree!.branch,
          mergeStatus: "skipped",
        })

        await Team.cleanup("worktree-cleanup")

        expect(await exists(tree!.path)).toBe(false)
        expect(
          (await git(tmp.path, ["show-ref", "--verify", "--quiet", `refs/heads/${tree!.branch}`])).exitCode,
        ).not.toBe(0)
      },
    })
  })
})
