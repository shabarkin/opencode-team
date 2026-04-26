import { describe, expect, test, spyOn } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Team, TeamTasks } from "../../src/team"
import { Log } from "../../src/util"
import {
  TeamCreateTool,
  TeamSpawnTool,
  TeamMessageTool,
  TeamBroadcastTool,
  TeamHealthTool,
  TeamTasksTool,
  TeamClaimTool,
  TeamRestartTool,
  TeamShutdownTool,
  TeamCleanupTool,
} from "../../src/tool/team"
import { TeamCollectTool } from "../../src/tool/team-collect"
import { Session, SessionPrompt, SessionStatus, Storage } from "../../src/team/runtime"
import { TeamNotepad } from "../../src/team/notepad"
import { TeamMessaging } from "../../src/team/messaging"
import { TeamStatusTool } from "../../src/tool/team-status"
import { TeamNotepadTool } from "../../src/tool/team-notepad"
import { Bus } from "../../src/bus"
import { TeamEvent } from "../../src/team/events"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { tmpdir } from "../fixture/fixture"
import { callTeamTool } from "./_tool-runtime"

Log.init({ print: false })

const projectRoot = path.join(__dirname, "../..")

async function seed(sessionID: string, text = "seed") {
  const messageID = MessageID.ascending()
  await Session.updateMessage({
    id: messageID,
    sessionID: SessionID.make(sessionID),
    role: "user",
    agent: "general",
    model: {
      providerID: ProviderID.make("openai"),
      modelID: ModelID.make("gpt-4.1"),
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

describe("Team", () => {
  test("create and get a team", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        const team = await Team.create({
          name: "test-team-1",
          leadSessionID: "ses_lead_123",
        })

        expect(team.name).toBe("test-team-1")
        expect(team.leadSessionID).toBe("ses_lead_123")
        expect(team.members).toEqual([])
        expect(team.created).toBeGreaterThan(0)

        const fetched = await Team.get("test-team-1")
        expect(fetched).toBeDefined()
        expect(fetched!.name).toBe("test-team-1")

        // Cleanup
        await Team.cleanup("test-team-1")
      },
    })
  })

  test("get returns undefined for non-existent team", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        const team = await Team.get("non-existent")
        expect(team).toBeUndefined()
      },
    })
  })

  test("create throws on duplicate team name", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        await Team.create({ name: "dup-team", leadSessionID: "ses_1" })
        await expect(Team.create({ name: "dup-team", leadSessionID: "ses_2" })).rejects.toThrow(
          'Team "dup-team" already exists',
        )

        await Team.cleanup("dup-team")
      },
    })
  })

  test("create rejects unsafe team names", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        for (const name of ["../escape", "bad/name", "Upper"]) {
          expect(() => Team.create({ name, leadSessionID: "ses_unsafe" })).toThrow()
        }
      },
    })
  })

  test("add and remove members", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        await Team.create({ name: "member-team", leadSessionID: "ses_lead" })

        await Team.addMember("member-team", {
          name: "researcher",
          sessionID: "ses_research_1",
          agent: "explore",
          status: "busy",
        })

        let team = await Team.get("member-team")
        expect(team!.members).toHaveLength(1)
        expect(team!.members[0].name).toBe("researcher")
        expect(team!.members[0].agent).toBe("explore")

        await Team.addMember("member-team", {
          name: "implementer",
          sessionID: "ses_impl_1",
          agent: "general",
          status: "busy",
        })

        team = await Team.get("member-team")
        expect(team!.members).toHaveLength(2)

        await Team.removeMember("member-team", "researcher")
        team = await Team.get("member-team")
        expect(team!.members).toHaveLength(1)
        expect(team!.members[0].name).toBe("implementer")

        // Cleanup: set remaining member to shutdown first
        await Team.setMemberStatus("member-team", "implementer", "shutdown")
        await Team.cleanup("member-team")
      },
    })
  })

  test("addMember rejects unsafe member names", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        await Team.create({ name: "safe-team", leadSessionID: "ses_lead_safe" })

        for (const name of ["../worker", "bad/name", "Worker"]) {
          expect(() =>
            Team.addMember("safe-team", {
              name,
              sessionID: "ses_worker_safe",
              agent: "general",
              status: "busy",
            }),
          ).toThrow()
        }

        await Team.cleanup("safe-team")
      },
    })
  })

  // TODO(team): Team.onCleanedRestorePermissions listener relies on a Bus
  // subscriber to fire after cleanup, which has the same async-tracking issue
  // as initFileTracking. Investigate Bus.subscribe Instance-context semantics.
  test.skip("cleanup only removes delegate rules added by team mode", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        const unsub = Team.onCleanedRestorePermissions()
        const session = await Session.create({
          permission: [
            {
              permission: "bash",
              pattern: "*",
              action: "deny",
            },
          ],
        })

        const created = await callTeamTool(TeamCreateTool, { name: "delegate-team", delegate: true }, {
          sessionID: session.id,
          messageID: "msg_1",
          agent: "general",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } as any)

        expect(created.title).toContain("delegate-team")

        await Team.cleanup("delegate-team")

        const next = await Session.get(session.id)
        expect(next.permission).toEqual([
          {
            permission: "bash",
            pattern: "*",
            action: "deny",
          },
        ])

        unsub()
        await Session.remove(session.id)
      },
    })
  })

  test("cleanup removes team notepad data", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        await Team.create({ name: "notepad-team", leadSessionID: "ses_lead_notepad" })
        await TeamNotepad.write("notepad-team", "plan", "keep docs current")

        expect(await TeamNotepad.read("notepad-team", "plan")).toBe("keep docs current")

        await Team.cleanup("notepad-team")

        expect(await TeamNotepad.read("notepad-team", "plan")).toBeUndefined()
      },
    })
  })

  test("setMemberStatus updates member", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        await Team.create({ name: "status-team", leadSessionID: "ses_lead" })
        await Team.addMember("status-team", {
          name: "worker",
          sessionID: "ses_w1",
          agent: "general",
          status: "busy",
        })

        await Team.setMemberStatus("status-team", "worker", "ready")
        let team = await Team.get("status-team")
        expect(team!.members[0].status).toBe("ready")

        await Team.setMemberStatus("status-team", "worker", "shutdown")
        team = await Team.get("status-team")
        expect(team!.members[0].status).toBe("shutdown")

        await Team.cleanup("status-team")
      },
    })
  })

  test("cleanup fails if active members exist", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        await Team.create({ name: "active-team", leadSessionID: "ses_lead" })
        await Team.addMember("active-team", {
          name: "busy-worker",
          sessionID: "ses_busy",
          agent: "general",
          status: "busy",
        })

        await expect(Team.cleanup("active-team")).rejects.toThrow("non-shutdown member")

        // Fix: shut down the worker, then clean up
        await Team.setMemberStatus("active-team", "busy-worker", "shutdown")
        await Team.cleanup("active-team")
      },
    })
  })

  test("cleanup waits for prompt shutdown acknowledgement", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        await Team.create({ name: "active-loop-team", leadSessionID: "ses_lead_loop" })
        await Team.addMember("active-loop-team", {
          name: "worker",
          sessionID: "ses_loop_worker",
          agent: "general",
          status: "shutdown",
        })

        const status = spyOn(SessionStatus, "get")
          .mockResolvedValueOnce({ type: "busy" } as any)
          .mockResolvedValueOnce({ type: "idle" } as any)

        await expect(Team.cleanup("active-loop-team")).rejects.toThrow("active session loops")
        await Team.cleanup("active-loop-team")

        status.mockRestore()
      },
    })
  })

  test("findBySession finds lead and member roles", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        await Team.create({ name: "find-team", leadSessionID: "ses_lead_find" })
        await Team.addMember("find-team", {
          name: "finder",
          sessionID: "ses_finder",
          agent: "explore",
          status: "busy",
        })

        const leadResult = await Team.findBySession("ses_lead_find")
        expect(leadResult).toBeDefined()
        expect(leadResult!.role).toBe("lead")

        const memberResult = await Team.findBySession("ses_finder")
        expect(memberResult).toBeDefined()
        expect(memberResult!.role).toBe("member")
        expect(memberResult!.memberName).toBe("finder")

        const notFound = await Team.findBySession("ses_unknown")
        expect(notFound).toBeUndefined()

        await Team.setMemberStatus("find-team", "finder", "shutdown")
        await Team.cleanup("find-team")
      },
    })
  })
})

describe("TeamTasks", () => {
  test("add and list tasks", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        await Team.create({ name: "task-team", leadSessionID: "ses_lead" })

        await TeamTasks.add("task-team", [
          { id: "t1", content: "Research auth module", status: "pending", priority: "high" },
          { id: "t2", content: "Review API endpoints", status: "pending", priority: "medium" },
        ])

        const tasks = await TeamTasks.list("task-team")
        expect(tasks).toHaveLength(2)
        expect(tasks[0].id).toBe("t1")
        expect(tasks[1].id).toBe("t2")

        await Team.cleanup("task-team")
      },
    })
  })

  test("claim task atomically", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        await Team.create({ name: "claim-team", leadSessionID: "ses_lead" })
        await TeamTasks.add("claim-team", [{ id: "t1", content: "Do work", status: "pending", priority: "high" }])

        const claimed = await TeamTasks.claim("claim-team", "t1", "worker-a")
        expect(claimed).toBe(true)

        // Second claim should fail
        const claimed2 = await TeamTasks.claim("claim-team", "t1", "worker-b")
        expect(claimed2).toBe(false)

        const tasks = await TeamTasks.list("claim-team")
        expect(tasks[0].status).toBe("in_progress")
        expect(tasks[0].assignee).toBe("worker-a")

        await Team.cleanup("claim-team")
      },
    })
  })

  test("claim respects dependencies", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        await Team.create({ name: "dep-team", leadSessionID: "ses_lead" })
        await TeamTasks.add("dep-team", [
          { id: "t1", content: "Step 1", status: "pending", priority: "high" },
          { id: "t2", content: "Step 2", status: "pending", priority: "high", depends_on: ["t1"] },
        ])

        // t2 should be blocked and unclaimed
        const claimBlocked = await TeamTasks.claim("dep-team", "t2", "worker")
        expect(claimBlocked).toBe(false)

        // Claim and complete t1
        await TeamTasks.claim("dep-team", "t1", "worker")
        await TeamTasks.complete("dep-team", "t1")

        // Now t2 should be claimable
        const tasks = await TeamTasks.list("dep-team")
        const t2 = tasks.find((t) => t.id === "t2")
        expect(t2!.status).toBe("pending") // auto-unblocked

        const claimUnblocked = await TeamTasks.claim("dep-team", "t2", "worker")
        expect(claimUnblocked).toBe(true)

        await Team.cleanup("dep-team")
      },
    })
  })

  test("self-dependency is removed during task resolution", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        await Team.create({ name: "self-dep-team", leadSessionID: "ses_lead" })
        await TeamTasks.add("self-dep-team", [
          {
            id: "t1",
            content: "Do work",
            status: "pending",
            priority: "high",
            depends_on: ["t1"],
          },
        ])

        const tasks = await TeamTasks.list("self-dep-team")
        expect(tasks[0].depends_on).toHaveLength(0)
        expect(tasks[0].status).toBe("pending")

        await Team.cleanup("self-dep-team")
      },
    })
  })

  test("complete auto-unblocks dependent tasks", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        await Team.create({ name: "unblock-team", leadSessionID: "ses_lead" })
        await TeamTasks.add("unblock-team", [
          { id: "t1", content: "Foundation", status: "pending", priority: "high" },
          { id: "t2", content: "Depends on t1", status: "pending", priority: "medium", depends_on: ["t1"] },
          { id: "t3", content: "Depends on t1 and t2", status: "pending", priority: "low", depends_on: ["t1", "t2"] },
        ])

        // t2 and t3 should be blocked initially
        let tasks = await TeamTasks.list("unblock-team")
        expect(tasks.find((t) => t.id === "t2")!.status).toBe("blocked")
        expect(tasks.find((t) => t.id === "t3")!.status).toBe("blocked")

        // Complete t1
        await TeamTasks.claim("unblock-team", "t1", "worker")
        await TeamTasks.complete("unblock-team", "t1")

        tasks = await TeamTasks.list("unblock-team")
        expect(tasks.find((t) => t.id === "t2")!.status).toBe("pending") // unblocked
        expect(tasks.find((t) => t.id === "t3")!.status).toBe("blocked") // still blocked (needs t2)

        await Team.cleanup("unblock-team")
      },
    })
  })

  test("update replaces the full task list", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        await Team.create({ name: "update-team", leadSessionID: "ses_lead" })
        await TeamTasks.add("update-team", [{ id: "old", content: "Old task", status: "pending", priority: "low" }])

        await TeamTasks.update("update-team", [
          { id: "new1", content: "New task 1", status: "pending", priority: "high" },
          { id: "new2", content: "New task 2", status: "in_progress", priority: "medium" },
        ])

        const tasks = await TeamTasks.list("update-team")
        expect(tasks).toHaveLength(2)
        expect(tasks[0].id).toBe("new1")

        await Team.cleanup("update-team")
      },
    })
  })
})

describe("Team auto-cleanup", () => {
  test("auto-cleanup waits for grace period and preserves lead access", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        const events: Array<{ teamName: string; grace: number; cleanupAt: number }> = []
        const stop = Team.autoCleanup({ grace: 50 })
        const off = Bus.subscribe(TeamEvent.AllMembersShutdown, (event) => {
          events.push(event.properties)
        })
        const ctx = {
          sessionID: "ses_lead_ac",
          messageID: "msg_ac",
          agent: "general",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } as any

        await Team.create({ name: "auto-clean-team", leadSessionID: "ses_lead_ac" })
        await Team.addMember("auto-clean-team", {
          name: "worker-a",
          sessionID: "ses_ac_a",
          agent: "general",
          status: "busy",
        })
        await Team.addMember("auto-clean-team", {
          name: "worker-b",
          sessionID: "ses_ac_b",
          agent: "general",
          status: "busy",
        })
        await TeamNotepad.write("auto-clean-team", "summary", "results ready")

        await Team.setMemberStatus("auto-clean-team", "worker-a", "shutdown")
        await Team.setMemberStatus("auto-clean-team", "worker-b", "shutdown")

        await Bun.sleep(20)

        expect(await Team.get("auto-clean-team")).toBeDefined()
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({
          teamName: "auto-clean-team",
          grace: 50,
        })
        expect(events[0]!.cleanupAt).toBeGreaterThanOrEqual(Date.now() - 1000)

        const snap = await callTeamTool(TeamStatusTool, {}, ctx)
        expect(snap.title).toBe("Team status: auto-clean-team")

        const note = await callTeamTool(TeamNotepadTool, { action: "read", key: "summary" }, ctx)
        expect(note.output).toBe("results ready")

        await Bun.sleep(60)
        const gone = await Team.get("auto-clean-team")
        expect(gone).toBeUndefined()

        off()
        stop()
        Team.cancelAutoCleanup("auto-clean-team")
      },
    })
  })

  test("manual cleanup during grace period cancels pending auto-cleanup", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        const stop = Team.autoCleanup({ grace: 100 })
        const clear = spyOn(globalThis, "clearTimeout")

        await Team.create({ name: "manual-clean-team", leadSessionID: "ses_lead_manual" })
        await Team.addMember("manual-clean-team", {
          name: "worker-1",
          sessionID: "ses_manual_1",
          agent: "general",
          status: "busy",
        })
        await Team.addMember("manual-clean-team", {
          name: "worker-2",
          sessionID: "ses_manual_2",
          agent: "general",
          status: "busy",
        })

        await Team.setMemberStatus("manual-clean-team", "worker-1", "shutdown")
        await Team.setMemberStatus("manual-clean-team", "worker-2", "shutdown")
        await Bun.sleep(20)

        expect(await Team.get("manual-clean-team")).toBeDefined()

        await Team.cleanup("manual-clean-team")
        await Bun.sleep(120)

        expect(await Team.get("manual-clean-team")).toBeUndefined()
        expect(clear).toHaveBeenCalled()

        clear.mockRestore()
        stop()
        Team.cancelAutoCleanup("manual-clean-team")
      },
    })
  })

  test("auto-cleanup does not trigger when some members are still active", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        const stop = Team.autoCleanup({ grace: 40 })

        await Team.create({ name: "no-clean-team", leadSessionID: "ses_lead_nc" })
        await Team.addMember("no-clean-team", {
          name: "worker-1",
          sessionID: "ses_nc_1",
          agent: "general",
          status: "busy",
        })
        await Team.addMember("no-clean-team", {
          name: "worker-2",
          sessionID: "ses_nc_2",
          agent: "general",
          status: "busy",
        })

        await Team.setMemberStatus("no-clean-team", "worker-1", "shutdown")
        await Bun.sleep(60)

        const team = await Team.get("no-clean-team")
        expect(team).toBeDefined()
        expect(team!.members).toHaveLength(2)

        await Team.setMemberStatus("no-clean-team", "worker-2", "shutdown")
        await Bun.sleep(60)

        expect(await Team.get("no-clean-team")).toBeUndefined()

        stop()
        Team.cancelAutoCleanup("no-clean-team")
      },
    })
  })

  test("auto-cleanup does not trigger on idle status changes", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        const stop = Team.autoCleanup({ grace: 40 })

        await Team.create({ name: "idle-team", leadSessionID: "ses_lead_idle" })
        await Team.addMember("idle-team", {
          name: "worker-idle",
          sessionID: "ses_idle_1",
          agent: "general",
          status: "busy",
        })

        await Team.setMemberStatus("idle-team", "worker-idle", "ready")
        await Bun.sleep(60)

        const team = await Team.get("idle-team")
        expect(team).toBeDefined()

        await Team.setMemberStatus("idle-team", "worker-idle", "shutdown")
        await Bun.sleep(60)

        expect(await Team.get("idle-team")).toBeUndefined()

        stop()
        Team.cancelAutoCleanup("idle-team")
      },
    })
  })

  test("auto-cleanup does not remove worktree teams", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        const stop = Team.autoCleanup({ grace: 40 })

        await Team.create({ name: "worktree-auto-team", leadSessionID: "ses_lead_wt_auto", worktrees: true })
        await Team.addMember("worktree-auto-team", {
          name: "worker-wt",
          sessionID: "ses_wt_auto_1",
          agent: "general",
          status: "shutdown",
          worktreePath: path.join(tmp.path, "missing"),
          worktreeBranch: "team/worktree-auto-team/worker-wt",
          mergeStatus: "pending",
        })

        await Bun.sleep(60)

        expect(await Team.get("worktree-auto-team")).toBeDefined()

        stop()
        Team.cancelAutoCleanup("worktree-auto-team")
      },
    })
  })
})

describe("Team messaging auto-wake", () => {
  test("broadcast wakes shutdown-requested members but not shutdown members", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        const lead = await Session.create({})
        const first = await Session.create({ parentID: lead.id })
        const second = await Session.create({ parentID: lead.id })
        const status = spyOn(SessionStatus, "get").mockResolvedValue({ type: "idle" } as any)
        const loop = spyOn(SessionPrompt, "loop").mockResolvedValue({} as any)

        await seed(lead.id, "lead")
        await seed(first.id, "first")
        await seed(second.id, "second")

        await Team.create({ name: "wake-team", leadSessionID: lead.id })
        await Team.addMember("wake-team", {
          name: "worker-a",
          sessionID: first.id,
          agent: "general",
          status: "shutdown_requested",
        })
        await Team.addMember("wake-team", {
          name: "worker-b",
          sessionID: second.id,
          agent: "general",
          status: "shutdown",
        })

        await TeamMessaging.broadcast({
          teamName: "wake-team",
          from: "lead",
          text: "Immediate freeze",
        })
        await Bun.sleep(10)

        const calls = loop.mock.calls.map((call) => call[0]?.sessionID)
        expect(calls).toContain(first.id)
        expect(calls).not.toContain(second.id)

        const msgs = await Session.messages({ sessionID: first.id })
        const part = msgs.at(-1)?.parts.find((item) => item.type === "text")
        expect(part?.type).toBe("text")
        if (part?.type === "text") {
          expect(part.text).toContain("[Team message from lead]: Immediate freeze")
        }
        expect((await Team.get("wake-team"))?.members.find((member) => member.name === "worker-a")?.status).toBe(
          "shutdown",
        )

        status.mockRestore()
        loop.mockRestore()
        await Team.cleanup("wake-team")
      },
    })
  })
})

describe("Team constraints", () => {
  test("one team per lead session", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        await Team.create({ name: "lead-team-1", leadSessionID: "ses_lead_single" })

        // Same session cannot lead a second team
        await expect(Team.create({ name: "lead-team-2", leadSessionID: "ses_lead_single" })).rejects.toThrow(
          "Only one team per session",
        )

        await Team.cleanup("lead-team-1")
      },
    })
  })

  test("teammate session cannot create a team", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        await Team.create({ name: "parent-team", leadSessionID: "ses_lead_parent" })
        await Team.addMember("parent-team", {
          name: "worker",
          sessionID: "ses_worker_nest",
          agent: "general",
          status: "busy",
        })

        // Worker session cannot create a team (no nesting)
        await expect(Team.create({ name: "nested-team", leadSessionID: "ses_worker_nest" })).rejects.toThrow(
          "Teammates cannot create new teams",
        )

        await Team.setMemberStatus("parent-team", "worker", "shutdown")
        await Team.cleanup("parent-team")
      },
    })
  })

  test("different sessions can lead different teams", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        const team1 = await Team.create({ name: "team-a", leadSessionID: "ses_lead_a" })
        const team2 = await Team.create({ name: "team-b", leadSessionID: "ses_lead_b" })

        expect(team1.name).toBe("team-a")
        expect(team2.name).toBe("team-b")

        await Team.cleanup("team-a")
        await Team.cleanup("team-b")
      },
    })
  })
})

describe("Team steering", () => {
  test("steer restarts ready or errored teammates and messages busy ones", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        const send = spyOn(TeamMessaging, "send").mockImplementation(async () => {})

        await Team.create({ name: "steer-team", leadSessionID: "ses_steer_lead" })
        await Team.addMember("steer-team", {
          name: "ready-worker",
          sessionID: "ses_steer_ready",
          agent: "general",
          status: "ready",
        })
        await Team.addMember("steer-team", {
          name: "error-worker",
          sessionID: "ses_steer_error",
          agent: "general",
          status: "error",
        })
        await Team.addMember("steer-team", {
          name: "busy-worker",
          sessionID: "ses_steer_busy",
          agent: "general",
          status: "busy",
        })

        expect(
          await Team.steer({
            teamName: "steer-team",
            memberName: "ready-worker",
            text: "continue",
          }),
        ).toBe("restart")
        expect(
          await Team.steer({
            teamName: "steer-team",
            memberName: "error-worker",
            text: "retry",
          }),
        ).toBe("restart")
        expect(
          await Team.steer({
            teamName: "steer-team",
            memberName: "busy-worker",
            text: "adjust course",
          }),
        ).toBe("message")

        const team = await Team.get("steer-team")
        expect(team?.members.find((m) => m.name === "ready-worker")?.status).toBe("ready")
        expect(team?.members.find((m) => m.name === "error-worker")?.status).toBe("ready")
        expect(team?.members.find((m) => m.name === "busy-worker")?.status).toBe("busy")
        expect(send).toHaveBeenNthCalledWith(1, {
          teamName: "steer-team",
          from: "lead",
          to: "ready-worker",
          text: "continue",
        })
        expect(send).toHaveBeenNthCalledWith(2, {
          teamName: "steer-team",
          from: "lead",
          to: "error-worker",
          text: "retry",
        })
        expect(send).toHaveBeenNthCalledWith(3, {
          teamName: "steer-team",
          from: "lead",
          to: "busy-worker",
          text: "adjust course",
        })

        send.mockRestore()
        await Team.setMemberStatus("steer-team", "ready-worker", "shutdown")
        await Team.setMemberStatus("steer-team", "error-worker", "shutdown")
        await Team.setMemberStatus("steer-team", "busy-worker", "shutdown")
        await Team.cleanup("steer-team")
      },
    })
  })

  test("steer resumes paused teammates and leaves errored teammates unchanged on delivery failure", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        const lead = await Session.create({})
        const paused = await Session.create({ parentID: lead.id })
        const errored = await Session.create({ parentID: lead.id })
        await seed(lead.id)
        await seed(paused.id)
        await seed(errored.id)

        await Team.create({ name: "steer-edges", leadSessionID: lead.id })
        await Team.addMember("steer-edges", {
          name: "paused-worker",
          sessionID: paused.id,
          agent: "general",
          status: "paused",
          checkpoint: "none",
          planApproval: "none",
        })
        await Team.addMember("steer-edges", {
          name: "error-worker",
          sessionID: errored.id,
          agent: "general",
          status: "error",
          checkpoint: "none",
          planApproval: "none",
        })

        const send = spyOn(TeamMessaging, "send")
          .mockResolvedValueOnce()
          .mockRejectedValueOnce(new Error("send failed"))

        expect(
          await Team.steer({
            teamName: "steer-edges",
            memberName: "paused-worker",
            text: "continue from checkpoint",
          }),
        ).toBe("resume")

        await expect(
          Team.steer({
            teamName: "steer-edges",
            memberName: "error-worker",
            text: "retry",
          }),
        ).rejects.toThrow("send failed")

        const team = await Team.get("steer-edges")
        expect(team?.members.find((m) => m.name === "paused-worker")?.status).toBe("busy")
        expect(team?.members.find((m) => m.name === "error-worker")?.status).toBe("error")

        send.mockRestore()
        await Team.setMemberStatus("steer-edges", "paused-worker", "shutdown")
        await Team.setMemberStatus("steer-edges", "error-worker", "shutdown")
        await Team.cleanup("steer-edges")
      },
    })
  })

  test("steer-all skips paused and shutdown-requested teammates and reports failures", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        const lead = await Session.create({})
        const ready = await Session.create({ parentID: lead.id })
        const paused = await Session.create({ parentID: lead.id })
        const stopping = await Session.create({ parentID: lead.id })
        await seed(lead.id)
        await seed(ready.id)
        await seed(paused.id)
        await seed(stopping.id)

        await Team.create({ name: "steer-all-team", leadSessionID: lead.id })
        await Team.addMember("steer-all-team", {
          name: "ready-worker",
          sessionID: ready.id,
          agent: "general",
          status: "ready",
        })
        await Team.addMember("steer-all-team", {
          name: "paused-worker",
          sessionID: paused.id,
          agent: "general",
          status: "paused",
        })
        await Team.addMember("steer-all-team", {
          name: "stopping-worker",
          sessionID: stopping.id,
          agent: "general",
          status: "shutdown_requested",
        })

        const broadcast = spyOn(TeamMessaging, "broadcast").mockResolvedValue({ targets: 1, delivered: 1, errors: [] })

        const result = await Team.steerAll({ teamName: "steer-all-team", text: "regroup" })
        expect(result).toEqual({ targets: 1, delivered: 1, errors: [] })
        expect(broadcast).toHaveBeenCalledTimes(1)
        expect(broadcast).toHaveBeenCalledWith({
          teamName: "steer-all-team",
          from: "lead",
          text: "regroup",
          targets: ["ready-worker"],
        })

        broadcast.mockRestore()
        await Team.setMemberStatus("steer-all-team", "ready-worker", "shutdown")
        await Team.setMemberStatus("steer-all-team", "paused-worker", "shutdown")
        await Team.setMemberStatus("steer-all-team", "stopping-worker", "shutdown")
        await Team.cleanup("steer-all-team")
      },
    })
  })
})

describe("Team tool definitions", () => {
  test("all team tools can be initialized", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        const tools = [
          TeamCreateTool,
          TeamSpawnTool,
          TeamMessageTool,
          TeamBroadcastTool,
          TeamCollectTool,
          TeamTasksTool,
          TeamClaimTool,
          TeamStatusTool,
          TeamNotepadTool,
          TeamHealthTool,
          TeamRestartTool,
          TeamShutdownTool,
          TeamCleanupTool,
        ]

        const { initTeamTool } = await import("./_tool-runtime")
        for (const tool of tools) {
          const initialized = await initTeamTool(tool)
          expect(initialized.description).toBeTruthy()
          expect(initialized.parameters).toBeDefined()
          expect(typeof initialized.execute).toBe("function")
        }
      },
    })
  })

  test("team tools have correct IDs", () => {
    expect(TeamCreateTool.id).toBe("team_create")
    expect(TeamSpawnTool.id).toBe("team_spawn")
    expect(TeamCollectTool.id).toBe("team_collect")
    expect(TeamMessageTool.id).toBe("team_message")
    expect(TeamBroadcastTool.id).toBe("team_broadcast")
    expect(TeamTasksTool.id).toBe("team_tasks")
    expect(TeamClaimTool.id).toBe("team_claim")
    expect(TeamShutdownTool.id).toBe("team_shutdown")
    expect(TeamCleanupTool.id).toBe("team_cleanup")
  })

  test("TeamCreateTool rejects teammate sessions", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        // Set up a team with a member
        await Team.create({ name: "tool-guard-team", leadSessionID: "ses_lead_guard" })
        await Team.addMember("tool-guard-team", {
          name: "guarded-worker",
          sessionID: "ses_guarded_worker",
          agent: "general",
          status: "busy",
        })

        const result = await callTeamTool(TeamCreateTool, { name: "nested-attempt" }, {
          sessionID: "ses_guarded_worker",
          messageID: "msg_1",
          agent: "general",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } as any)

        expect(result.title).toBe("Error")
        expect(result.output).toContain("Teammates cannot create new teams")

        await Team.setMemberStatus("tool-guard-team", "guarded-worker", "shutdown")
        await Team.cleanup("tool-guard-team")
      },
    })
  })

  test("TeamCreateTool rejects session already leading a team", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        await Team.create({ name: "existing-lead-team", leadSessionID: "ses_existing_lead" })

        const result = await callTeamTool(TeamCreateTool, { name: "second-team" }, {
          sessionID: "ses_existing_lead",
          messageID: "msg_1",
          agent: "general",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } as any)

        expect(result.title).toBe("Error")
        expect(result.output).toContain("already leading team")

        await Team.cleanup("existing-lead-team")
      },
    })
  })

  test("TeamCreateTool includes the collection workflow and stores delivery config", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        const lead = await Session.create({})
        await seed(lead.id)

        const result = await callTeamTool(
          TeamCreateTool,
          { name: "workflow-team", receipts: true, output_format: "single_synthesis" },
          {
            sessionID: lead.id,
            messageID: "msg_1",
            agent: "general",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          } as any,
        )

        expect(result.output).toContain("CRITICAL WORKFLOW")
        expect(result.output).toContain("LEAD ROLE (while this team is active)")
        expect(result.output).toContain("Own the goal, task breakdown, delegation, pacing, and final synthesis")
        expect(result.output).toContain("Do NOT become the main executor")
        expect(result.output).toContain("team_collect")
        expect(result.output).toContain("Facilitate peer-to-peer interaction")
        expect(result.output).toContain("Only shut teammates down after reviews are complete")
        expect(result.output).toContain("DELIVERY DISCIPLINE")
        expect(result.output).toContain("Prefer delegation, steering, consensus-building, and result collection")
        expect(result.output).toContain("OUTPUT FORMAT: Produce one concise narrative synthesis")

        expect(await Team.get("workflow-team")).toMatchObject({
          receipts: true,
          output_format: "single_synthesis",
          team_phase: "spawning",
          delivered: false,
        })

        await Team.cleanup("workflow-team")
      },
    })
  })

  test("TeamShutdownTool rejects non-lead sessions", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        await Team.create({ name: "shutdown-guard-team", leadSessionID: "ses_shutdown_lead" })
        await Team.addMember("shutdown-guard-team", {
          name: "worker-x",
          sessionID: "ses_worker_x",
          agent: "general",
          status: "busy",
        })

        // Member tries to shutdown another member — should fail
        const result = await callTeamTool(TeamShutdownTool, { name: "worker-x" }, {
          sessionID: "ses_worker_x",
          messageID: "msg_1",
          agent: "general",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } as any)

        expect(result.title).toBe("Error")
        expect(result.output).toContain("Only the team lead")

        await Team.setMemberStatus("shutdown-guard-team", "worker-x", "shutdown")
        await Team.cleanup("shutdown-guard-team")
      },
    })
  })

  test("TeamShutdownTool cancels busy members and starts a final shutdown loop", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        await Team.create({ name: "shutdown-busy-team", leadSessionID: "ses_shutdown_busy_lead" })
        await Team.addMember("shutdown-busy-team", {
          name: "worker-y",
          sessionID: "ses_worker_y",
          agent: "general",
          status: "busy",
        })

        const send = spyOn(TeamMessaging, "send").mockImplementation(async () => {})
        const cancel = spyOn(Team, "cancelMember").mockResolvedValue(true)
        const status = spyOn(SessionStatus, "get").mockResolvedValue({ type: "idle" } as any)
        const loop = spyOn(SessionPrompt, "loop").mockResolvedValue({} as any)
        const timer = spyOn(globalThis, "setTimeout").mockImplementation((() => 1) as any)

        const result = await callTeamTool(TeamShutdownTool, { name: "worker-y" }, {
          sessionID: "ses_shutdown_busy_lead",
          messageID: "msg_1",
          agent: "general",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } as any)

        await Bun.sleep(10)

        expect(result.title).toBe("Shutdown requested: worker-y")
        expect(cancel).toHaveBeenCalledWith("shutdown-busy-team", "worker-y")
        expect(loop).toHaveBeenCalledWith({ sessionID: "ses_worker_y" })
        expect((await Team.get("shutdown-busy-team"))?.members.find((m) => m.name === "worker-y")?.status).toBe(
          "shutdown",
        )

        timer.mockRestore()
        loop.mockRestore()
        status.mockRestore()
        cancel.mockRestore()
        send.mockRestore()
        await Team.cleanup("shutdown-busy-team")
      },
    })
  })

  test("pause leaves busy members running when cancellation never settles", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        await Team.create({ name: "pause-stuck-team", leadSessionID: "ses_pause_lead" })
        await Team.addMember("pause-stuck-team", {
          name: "worker",
          sessionID: "ses_pause_worker",
          agent: "general",
          status: "busy",
          execution_status: "running",
        })

        const cancel = spyOn(SessionPrompt, "cancel").mockResolvedValue(undefined)
        const status = spyOn(SessionStatus, "get").mockResolvedValue({ type: "busy" } as any)

        await expect(Team.pause({ teamName: "pause-stuck-team", memberName: "worker" })).rejects.toThrow(
          'Teammate "worker" did not stop after pause was requested.',
        )
        expect((await Team.get("pause-stuck-team"))?.members.find((member) => member.name === "worker")?.status).toBe(
          "busy",
        )

        cancel.mockRestore()
        status.mockRestore()
      },
    })
  })

  test("forceShutdownAll leaves stuck members pending until their loops stop", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        await Team.create({ name: "force-stuck-team", leadSessionID: "ses_force_lead" })
        await Team.addMember("force-stuck-team", {
          name: "worker",
          sessionID: "ses_force_worker",
          agent: "general",
          status: "busy",
          execution_status: "running",
        })

        const cancel = spyOn(SessionPrompt, "cancel").mockResolvedValue(undefined)
        const status = spyOn(SessionStatus, "get").mockResolvedValue({ type: "busy" } as any)

        const result = await Team.forceShutdownAll("force-stuck-team", "emergency")
        expect(result.pending).toEqual(["worker"])
        expect(result.shutdown).toEqual([])
        expect((await Team.get("force-stuck-team"))?.members.find((member) => member.name === "worker")?.status).toBe(
          "shutdown_requested",
        )

        cancel.mockRestore()
        status.mockRestore()
      },
    })
  })

  test("TeamShutdownTool force shuts down stuck members after timeout", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        await Team.create({ name: "shutdown-timeout-team", leadSessionID: "ses_shutdown_timeout_lead" })
        await Team.addMember("shutdown-timeout-team", {
          name: "worker-z",
          sessionID: "ses_worker_z",
          agent: "general",
          status: "ready",
        })

        const wait: Array<() => Promise<void>> = []
        const send = spyOn(TeamMessaging, "send").mockImplementation(async () => {})
        const status = spyOn(SessionStatus, "get").mockResolvedValue({ type: "idle" } as any)
        const loop = spyOn(SessionPrompt, "loop").mockImplementation(((_input: any) => new Promise(() => {})) as any)
        const cancel = spyOn(SessionPrompt, "cancel").mockResolvedValue(undefined)
        const timer = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => Promise<void>) => {
          wait.push(fn)
          return 1 as any
        }) as any)

        await callTeamTool(TeamShutdownTool, { name: "worker-z" }, {
          sessionID: "ses_shutdown_timeout_lead",
          messageID: "msg_1",
          agent: "general",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } as any)

        expect(wait).toHaveLength(1)
        await wait[0]!()

        expect(cancel).not.toHaveBeenCalled()
        expect((await Team.get("shutdown-timeout-team"))?.members.find((m) => m.name === "worker-z")?.status).toBe(
          "shutdown",
        )

        timer.mockRestore()
        cancel.mockRestore()
        loop.mockRestore()
        status.mockRestore()
        send.mockRestore()
        await Team.cleanup("shutdown-timeout-team")
      },
    })
  })

  test("TeamClaimTool rejects session not in a team", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        const result = await callTeamTool(TeamClaimTool, { task_id: "t1" }, {
          sessionID: "ses_orphan",
          messageID: "msg_1",
          agent: "general",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } as any)

        expect(result.title).toBe("Error")
        expect(result.output).toContain("not part of any team")
      },
    })
  })

  test("TeamTasksTool lists tasks for team member", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        await Team.create({ name: "tasks-tool-team", leadSessionID: "ses_tasks_lead" })
        await TeamTasks.add("tasks-tool-team", [
          { id: "t1", content: "First task", status: "pending", priority: "high" },
          { id: "t2", content: "Second task", status: "pending", priority: "medium" },
        ])

        const result = await callTeamTool(TeamTasksTool, { action: "list" }, {
          sessionID: "ses_tasks_lead",
          messageID: "msg_1",
          agent: "general",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } as any)

        expect(result.title).toBe("Task list")
        expect(result.output).toContain("First task")
        expect(result.output).toContain("Second task")
        expect(result.metadata.count).toBe(2)

        await Team.cleanup("tasks-tool-team")
      },
    })
  })

  test("TeamSpawnTool accepts an exact custom agent display name", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          security_hunter: {
            name: "Security Researcher Hunter",
            description: "Security-focused custom subagent",
            mode: "subagent",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        await Team.create({ name: "named-agent-team", leadSessionID: "ses_named_lead" })

        const spawn = spyOn(Team, "spawnMember").mockResolvedValue({
          sessionID: "ses_named_child",
          label: "test/model",
        })

        const { initTeamTool } = await import("./_tool-runtime")
        const tool = await initTeamTool(TeamSpawnTool)
        expect(tool.description).toContain("Security Researcher Hunter")
        expect(tool.description).toContain("stay focused on orchestration")

        const result = await callTeamTool(
          TeamSpawnTool,
          {
            name: "worker",
            agent: "Security Researcher Hunter",
            prompt: "Review the plan",
          },
          {
            sessionID: "ses_named_lead" as any,
            messageID: "msg_named" as any,
            agent: "build",
            abort: new AbortController().signal,
            messages: [
              {
                info: {
                  role: "user",
                  model: {
                    providerID: "test",
                    modelID: "model",
                  },
                },
              },
            ] as any,
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect(result.title).toBe("Spawned teammate: worker")
        expect(result.output).toContain("Stay in LEAD MODE while this team is active")
        expect(result.output).toContain("avoid taking this task back yourself")
        expect(result.output).toContain("Facilitate teammate-to-teammate coordination")
        expect(result.output).toContain("Do not rush shutdown while a teammate is still mid-review")
        expect(result.output).toContain("team_collect")
        expect(spawn).toHaveBeenCalledWith(
          expect.objectContaining({
            teamName: "named-agent-team",
            name: "worker",
            parentSessionID: "ses_named_lead",
            agent: expect.objectContaining({
              name: "Security Researcher Hunter",
            }),
          }),
        )

        spawn.mockRestore()
        await Team.cleanup("named-agent-team")
      },
    })
  })

  test("TeamStatusTool uses member timestamps instead of team age", async () => {
    await Instance.provide({
      directory: projectRoot,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        await Team.create({ name: "status-tool-team", leadSessionID: "ses_status_lead" })
        await Team.addMember("status-tool-team", {
          name: "worker",
          sessionID: "ses_status_worker",
          agent: "general",
          status: "busy",
        })

        await Storage.update(["team", Instance.project.id, "status-tool-team"], (draft: any) => {
          draft.created = Date.now() - 60 * 60 * 1000
          draft.members[0].updated = Date.now() - 30 * 1000
          draft.members[0].started = Date.now() - 30 * 1000
        })

        const result = await callTeamTool(TeamStatusTool, {}, {
          sessionID: "ses_status_lead",
          messageID: "msg_1",
          agent: "general",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } as any)

        const line = (result.output as string)
          .split("\n")
          .find((item: string) => item.includes("worker") && item.includes("agent=general"))

        expect(line).toBeDefined()
        expect(line).toMatch(/\| [01]m$/)

        await Team.setMemberStatus("status-tool-team", "worker", "shutdown")
        await Team.cleanup("status-tool-team")
      },
    })
  })
})
