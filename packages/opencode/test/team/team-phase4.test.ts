import { describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { Env } from "../../src/env"
import { Inbox } from "../../src/team/inbox"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SubmittedResultSchema, Team, TeamTasks } from "../../src/team"
import { TeamPolicy } from "../../src/team/policy"
import { TeamScope } from "../../src/team/scope"
import { TeamCleanupTool, TeamSpawnTool } from "../../src/tool/team"
import { TeamPhaseTool, TeamShutdownAllTool } from "../../src/tool/team-lifecycle"
import { TeamInboxTool, TeamSubmitResultTool, TeamWaitTool } from "../../src/tool/team-inbox"
import { TeamStatusTool } from "../../src/tool/team-status"
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

function ctx(sessionID: string, messages: any[] = []) {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    agent: "general",
    abort: new AbortController().signal,
    messages,
    metadata: () => {},
    ask: async () => {},
  } as any
}

async function basic(name: string, status: "ready" | "busy" | "error" = "ready") {
  const lead = await Session.create({})
  const member = await Session.create({ parentID: lead.id })
  await seed(lead.id)
  await seed(member.id)
  await Team.create({ name, leadSessionID: lead.id })
  await Team.addMember(name, {
    name: "worker",
    sessionID: member.id,
    agent: "general",
    status,
    execution_status: status === "busy" ? "running" : "idle",
    checkpoint: "none",
    planApproval: "none",
  })
  return { lead, member }
}

async function finish(name: string) {
  const team = await Team.get(name)
  if (!team) return
  for (const member of team.members) {
    await Team.setMemberStatus(name, member.name, "shutdown")
  }
  await Team.cleanup(name).catch(() => undefined)
}

describe("team phase 4", () => {
  test("team_inbox list returns unread messages with summary fields", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const { lead } = await basic("phase4-inbox-list")
        await Inbox.write("phase4-inbox-list", "lead", {
          id: "im_one",
          from: "worker",
          text: "Finished the audit and found two issues.",
          timestamp: Date.now(),
          type: "result",
          priority: "urgent",
        })

        const out = await (await TeamInboxTool.init()).execute({ action: "list" }, ctx(lead.id))
        expect(out.output).toContain("from=worker")
        expect(out.output).toContain("type=result")
        expect(out.output).toContain("priority=urgent")
        expect(out.output).toContain("read=no")

        await finish("phase4-inbox-list")
      },
    })
  })

  test("team_inbox read marks messages as read", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const { lead } = await basic("phase4-inbox-read")
        await Inbox.write("phase4-inbox-read", "lead", {
          id: "im_two",
          from: "worker",
          text: "Detailed result body.",
          timestamp: Date.now(),
          type: "result",
        })

        const out = await (await TeamInboxTool.init()).execute({ action: "read" }, ctx(lead.id))
        expect(out.output).toContain("Detailed result body.")
        expect((await Inbox.unread("phase4-inbox-read", "lead")).length).toBe(0)

        await finish("phase4-inbox-read")
      },
    })
  })

  test("team_inbox read with filters only marks displayed messages as read", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const { lead } = await basic("phase4-inbox-read-limit")
        await Inbox.write("phase4-inbox-read-limit", "lead", {
          id: "im_three",
          from: "worker",
          text: "First unread body.",
          timestamp: Date.now() - 20,
        })
        await Inbox.write("phase4-inbox-read-limit", "lead", {
          id: "im_four",
          from: "worker",
          text: "Second unread body.",
          timestamp: Date.now() - 10,
        })
        await Inbox.write("phase4-inbox-read-limit", "lead", {
          id: "im_five",
          from: "worker",
          text: "Third unread body.",
          timestamp: Date.now(),
        })

        const out = await (await TeamInboxTool.init()).execute({ action: "read", limit: 2 }, ctx(lead.id))
        expect(out.output).toContain("Third unread body.")
        expect(out.output).toContain("Second unread body.")
        expect(out.output).not.toContain("First unread body.")
        expect((await Inbox.unread("phase4-inbox-read-limit", "lead")).map((item) => item.id)).toEqual(["im_three"])

        await finish("phase4-inbox-read-limit")
      },
    })
  })

  test("team_inbox non-lead cannot read another member's inbox", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const { member } = await basic("phase4-inbox-auth")
        const out = await (await TeamInboxTool.init()).execute({ action: "list", member: "lead" }, ctx(member.id))
        expect(out.title).toBe("Error")
        expect(out.output).toContain("Only the lead")

        await finish("phase4-inbox-auth")
      },
    })
  })

  test("team_submit_result sends structured result to lead inbox", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const { member } = await basic("phase4-submit-result")
        const out = await (
          await TeamSubmitResultTool.init()
        ).execute(
          {
            title: "Audit complete",
            summary: "All planned checks passed.",
            status: "success",
            files_changed: ["src/team/index.ts"],
          },
          ctx(member.id),
        )

        expect(out.title).toContain("Result submitted")
        const items = await Inbox.all("phase4-submit-result", "lead")
        const item = items.find((entry) => entry.type === "result")
        expect(item?.metadata?.result).toMatchObject({ title: "Audit complete", status: "success" })

        await finish("phase4-submit-result")
      },
    })
  })

  test("team_submit_result includes evidence tier in the rendered inbox message", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const { member } = await basic("phase4-evidence-tier")
        await (
          await TeamSubmitResultTool.init()
        ).execute(
          {
            title: "Audit complete",
            summary: "Everything that mattered is covered.",
            status: "success",
            evidence_tier: "publicly_evidenced",
          },
          ctx(member.id),
        )

        const item = (await Inbox.all("phase4-evidence-tier", "lead")).find((entry) => entry.type === "result")
        expect(item?.text).toContain("Evidence tier: publicly_evidenced")
        expect(item?.metadata?.result).toMatchObject({ evidence_tier: "publicly_evidenced" })

        await finish("phase4-evidence-tier")
      },
    })
  })

  test("team_submit_result with task_id auto-completes the task", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const { member } = await basic("phase4-submit-task")
        await TeamTasks.add("phase4-submit-task", [
          { id: "t1", content: "Ship it", status: "pending", priority: "high" },
        ])

        await (
          await TeamSubmitResultTool.init()
        ).execute(
          {
            title: "Done",
            summary: "Task is finished.",
            status: "success",
            task_id: "t1",
          },
          ctx(member.id),
        )

        expect((await TeamTasks.list("phase4-submit-task")).find((item) => item.id === "t1")?.status).toBe("completed")

        await finish("phase4-submit-task")
      },
    })
  })

  test("team_wait returns immediately when result already exists", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const { lead, member } = await basic("phase4-wait-result")
        await (
          await TeamSubmitResultTool.init()
        ).execute(
          {
            title: "Ready",
            summary: "A result is already waiting.",
            status: "success",
          },
          ctx(member.id),
        )

        const out = await (await TeamWaitTool.init()).execute({ for: "result", member: "worker" }, ctx(lead.id))
        expect(out.title).toBe("Condition met")
        expect(out.output).toContain('Found a result from "worker"')

        await finish("phase4-wait-result")
      },
    })
  })

  test("team_wait returns not-yet when inbox empty", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const { lead } = await basic("phase4-wait-empty")
        const out = await (await TeamWaitTool.init()).execute({ for: "any_message" }, ctx(lead.id))
        expect(out.title).toBe("Condition not met")
        expect(out.output).toContain("No unread messages")

        await finish("phase4-wait-empty")
      },
    })
  })

  test("SubmittedResultSchema validates required fields and rejects oversized inputs", () => {
    expect(
      SubmittedResultSchema.parse({
        title: "Okay",
        summary: "Fine",
        status: "success",
      }),
    ).toMatchObject({ title: "Okay", status: "success" })

    expect(() =>
      SubmittedResultSchema.parse({
        title: "x".repeat(121),
        summary: "Fine",
        status: "success",
      }),
    ).toThrow()
  })

  test("team_shutdown_all sends shutdown request after teammates finish their work", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const lead = await Session.create({})
        const a = await Session.create({ parentID: lead.id })
        const b = await Session.create({ parentID: lead.id })
        await Team.create({ name: "phase4-shutdown-all", leadSessionID: lead.id })
        await Team.addMember("phase4-shutdown-all", { name: "a", sessionID: a.id, agent: "general", status: "ready" })
        await Team.addMember("phase4-shutdown-all", { name: "b", sessionID: b.id, agent: "general", status: "ready" })
        await Team.setMemberResultAt("phase4-shutdown-all", "a", Date.now())
        await Team.setMemberResultAt("phase4-shutdown-all", "b", Date.now())

        const shut = spyOn(Team, "shutdown").mockResolvedValue({ status: "requested" })
        const out = await (await TeamShutdownAllTool.init()).execute({}, ctx(lead.id))
        expect(out.output).toContain("Requested shutdown for 2 teammate")
        expect(out.output).toContain("call team_cleanup to end team mode")
        expect(shut).toHaveBeenCalledTimes(2)

        shut.mockRestore()
        await finish("phase4-shutdown-all")
      },
    })
  })

  test("team_shutdown_all defers while teammates are still mid-review", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const { lead } = await basic("phase4-shutdown-defer", "busy")
        await TeamTasks.add("phase4-shutdown-defer", [
          { id: "review", content: "Finish the review", status: "in_progress", priority: "high", assignee: "worker" },
        ])

        const shut = spyOn(Team, "shutdown").mockResolvedValue({ status: "requested" })
        const out = await (await TeamShutdownAllTool.init()).execute({}, ctx(lead.id))
        expect(out.title).toBe("Shutdown deferred")
        expect(out.output).toContain("worker")
        expect(out.output).toContain("not yet reported completion")
        expect(out.output).toContain("team_message")
        expect(shut).not.toHaveBeenCalled()

        shut.mockRestore()
        await finish("phase4-shutdown-defer")
      },
    })
  })

  test("team_shutdown_all allows shutdown when repeated noise makes the channel unhealthy", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const { lead } = await basic("phase4-shutdown-noise", "busy")
        await TeamTasks.add("phase4-shutdown-noise", [
          { id: "review", content: "Finish the review", status: "in_progress", priority: "high", assignee: "worker" },
        ])
        for (const id of ["im_1", "im_2", "im_3", "im_4", "im_5", "im_6"]) {
          await Inbox.write("phase4-shutdown-noise", "lead", {
            id,
            from: "system",
            text: `Noise ${id}`,
            timestamp: Date.now(),
            type: "error",
            priority: "urgent",
          })
        }

        const shut = spyOn(Team, "shutdown").mockResolvedValue({ status: "requested" })
        const out = await (await TeamShutdownAllTool.init()).execute({}, ctx(lead.id))
        expect(out.output).toContain("Repeated error/noise detected")
        expect(shut).toHaveBeenCalledTimes(1)

        shut.mockRestore()
        await finish("phase4-shutdown-noise")
      },
    })
  })

  test("team_shutdown_all ignores stale read noise in the lead inbox", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const { lead } = await basic("phase4-shutdown-stale", "busy")
        await TeamTasks.add("phase4-shutdown-stale", [
          { id: "review", content: "Finish the review", status: "in_progress", priority: "high", assignee: "worker" },
        ])
        for (const id of ["im_s1", "im_s2", "im_s3", "im_s4", "im_s5", "im_s6"]) {
          await Inbox.write("phase4-shutdown-stale", "lead", {
            id,
            from: "system",
            text: `BACKLOG alert ${id}`,
            timestamp: Date.now() - 60_000,
            type: "error",
            priority: "urgent",
          })
        }
        await Inbox.markRead("phase4-shutdown-stale", "lead")

        const shut = spyOn(Team, "shutdown").mockResolvedValue({ status: "requested" })
        const out = await (await TeamShutdownAllTool.init()).execute({}, ctx(lead.id))
        expect(out.title).toBe("Shutdown deferred")
        expect(shut).not.toHaveBeenCalled()

        shut.mockRestore()
        await finish("phase4-shutdown-stale")
      },
    })
  })

  test("team_shutdown_all ignores deadline alerts when deciding if the channel is noisy", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const { lead } = await basic("phase4-shutdown-deadline", "busy")
        await TeamTasks.add("phase4-shutdown-deadline", [
          { id: "review", content: "Finish the review", status: "in_progress", priority: "high", assignee: "worker" },
        ])
        for (const id of ["im_d1", "im_d2", "im_d3", "im_d4", "im_d5", "im_d6"]) {
          await Inbox.write("phase4-shutdown-deadline", "lead", {
            id,
            from: "system",
            text: `DEADLINE EXPIRED: worker alert ${id}`,
            timestamp: Date.now(),
            type: "error",
            priority: "urgent",
          })
        }

        const shut = spyOn(Team, "shutdown").mockResolvedValue({ status: "requested" })
        const out = await (await TeamShutdownAllTool.init()).execute({}, ctx(lead.id))
        expect(out.title).toBe("Shutdown deferred")
        expect(shut).not.toHaveBeenCalled()

        shut.mockRestore()
        await finish("phase4-shutdown-deadline")
      },
    })
  })

  test("team_shutdown_all defers for ready teammates without completion evidence", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const { lead } = await basic("phase4-shutdown-ready", "ready")

        const shut = spyOn(Team, "shutdown").mockResolvedValue({ status: "requested" })
        const out = await (await TeamShutdownAllTool.init()).execute({}, ctx(lead.id))
        expect(out.title).toBe("Shutdown deferred")
        expect(out.output).toContain("worker")
        expect(shut).not.toHaveBeenCalled()

        shut.mockRestore()
        await finish("phase4-shutdown-ready")
      },
    })
  })

  test("busy member with submitted result does not block shutdown", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const { lead } = await basic("phase4-shutdown-busy-done", "busy")
        await Team.setMemberResultAt("phase4-shutdown-busy-done", "worker", Date.now())

        const shut = spyOn(Team, "shutdown").mockResolvedValue({ status: "requested" })
        const out = await (await TeamShutdownAllTool.init()).execute({}, ctx(lead.id))
        expect(out.title).toBe("Shutdown requested for all teammates")
        expect(out.output).toContain("Requested shutdown for 1 teammate")
        expect(shut).toHaveBeenCalledTimes(1)

        shut.mockRestore()
        await finish("phase4-shutdown-busy-done")
      },
    })
  })

  test("paused member does not block shutdown", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const lead = await Session.create({})
        const member = await Session.create({ parentID: lead.id })
        await seed(lead.id)
        await seed(member.id)
        await Team.create({ name: "phase4-shutdown-paused", leadSessionID: lead.id })
        await Team.addMember("phase4-shutdown-paused", {
          name: "worker",
          sessionID: member.id,
          agent: "general",
          status: "paused",
          execution_status: "idle",
          checkpoint: "none",
          planApproval: "none",
        })

        const shut = spyOn(Team, "shutdown").mockResolvedValue({ status: "requested" })
        const out = await (await TeamShutdownAllTool.init()).execute({}, ctx(lead.id))
        expect(out.title).toBe("Shutdown requested for all teammates")
        expect(out.output).toContain("done or ready to wrap up")
        expect(shut).toHaveBeenCalledTimes(1)

        shut.mockRestore()
        await finish("phase4-shutdown-paused")
      },
    })
  })

  test("busy→ready lifecycle with result allows shutdown", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const { lead } = await basic("phase4-shutdown-lifecycle", "busy")
        await Team.setMemberResultAt("phase4-shutdown-lifecycle", "worker", Date.now())
        await Team.setMemberStatus("phase4-shutdown-lifecycle", "worker", "ready")

        const shut = spyOn(Team, "shutdown").mockResolvedValue({ status: "requested" })
        const out = await (await TeamShutdownAllTool.init()).execute({}, ctx(lead.id))
        expect(out.title).toBe("Shutdown requested for all teammates")
        expect(out.output).toContain("done or ready to wrap up")
        expect(shut).toHaveBeenCalledTimes(1)

        shut.mockRestore()
        await finish("phase4-shutdown-lifecycle")
      },
    })
  })

  test("storm path suggests force when graceful shutdown is blocked", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const { lead } = await basic("phase4-shutdown-storm-blocked", "busy")
        await TeamTasks.add("phase4-shutdown-storm-blocked", [
          { id: "review", content: "Finish the review", status: "in_progress", priority: "high", assignee: "worker" },
        ])
        for (const id of ["im_b1", "im_b2", "im_b3", "im_b4", "im_b5", "im_b6"]) {
          await Inbox.write("phase4-shutdown-storm-blocked", "lead", {
            id,
            from: "system",
            text: `Noise ${id}`,
            timestamp: Date.now(),
            type: "error",
            priority: "urgent",
          })
        }

        const shut = spyOn(Team, "shutdown").mockResolvedValue({ status: "blocked", reason: "policy denied" })
        const out = await (await TeamShutdownAllTool.init()).execute({}, ctx(lead.id))
        expect(out.output).toContain("Repeated error/noise detected")
        expect(out.output).toContain("Blocked")
        expect(out.output).toContain("consider force=true")

        shut.mockRestore()
        await finish("phase4-shutdown-storm-blocked")
      },
    })
  })

  test("team_shutdown_all force=true calls forceShutdownAll", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const { lead } = await basic("phase4-shutdown-force")
        const force = spyOn(Team, "forceShutdownAll").mockResolvedValue()
        const out = await (await TeamShutdownAllTool.init()).execute({ force: true }, ctx(lead.id))
        expect(out.output).toContain("Force shutdown")
        expect(out.output).toContain("call team_cleanup to end team mode")
        expect(force).toHaveBeenCalledWith("phase4-shutdown-force", undefined)

        force.mockRestore()
        await finish("phase4-shutdown-force")
      },
    })
  })

  test("team_cleanup force=true shuts down stragglers before cleaning", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const { lead } = await basic("phase4-cleanup-force")
        const force = spyOn(Team, "forceShutdownAll").mockImplementation(async (teamName) => {
          await Team.setMemberStatus(teamName, "worker", "shutdown")
        })

        const out = await (
          await TeamCleanupTool.init()
        ).execute({ name: "phase4-cleanup-force", force: true }, ctx(lead.id))
        expect(out.title).toContain("Team cleaned up")
        expect(out.output).toContain("Resume normal non-team chat behavior")
        expect(force).toHaveBeenCalled()
        expect(await Team.get("phase4-cleanup-force")).toBeUndefined()

        force.mockRestore()
      },
    })
  })

  test("team_cleanup blocks when force=false and members are alive", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const { lead } = await basic("phase4-cleanup-block")
        const out = await (await TeamCleanupTool.init()).execute({ name: "phase4-cleanup-block" }, ctx(lead.id))
        expect(out.title).toBe("Cleanup failed")
        expect(out.output).toContain("Shut them down first")
        expect((await Team.get("phase4-cleanup-block"))?.team_phase).toBeUndefined()

        await finish("phase4-cleanup-block")
      },
    })
  })

  test("cleanup rejects concurrent cleanup attempts", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const { lead } = await basic("phase4-cleanup-race")
        await Team.setMemberStatus("phase4-cleanup-race", "worker", "shutdown")

        let release = () => {}
        const wait = new Promise<void>((resolve) => {
          release = resolve
        })
        const remove = spyOn(Inbox, "removeAll").mockImplementation(async () => {
          await wait
        })

        const first = Team.cleanup("phase4-cleanup-race")
        await Bun.sleep(0)

        await expect(Team.cleanup("phase4-cleanup-race")).rejects.toThrow("cleanup already in progress")

        release()
        await first

        remove.mockRestore()
        await Session.remove(SessionID.make(lead.id))
      },
    })
  })

  test("TeamScope.checkPath rejects excluded path", () => {
    const out = TeamScope.checkPath(".ananke/session.json", { path_excludes: [".ananke/**"] }, "/tmp/repo")
    expect(out.allow).toBe(false)
  })

  test("TeamScope.checkPath allows path not in excludes", () => {
    const out = TeamScope.checkPath("src/index.ts", { path_excludes: [".ananke/**"] }, "/tmp/repo")
    expect(out.allow).toBe(true)
  })

  test("TeamScope path_includes restricts to allowed paths only", () => {
    expect(TeamScope.checkPath("src/index.ts", { path_includes: ["src/**"] }, "/tmp/repo").allow).toBe(true)
    expect(TeamScope.checkPath("test/index.ts", { path_includes: ["src/**"] }, "/tmp/repo").allow).toBe(false)
  })

  test("TeamScope.merge keeps team excludes while member overrides includes", () => {
    expect(
      TeamScope.merge(
        { path_excludes: [".env"], path_includes: ["src/**"], bash_allowlist: ["bun test *"] },
        { path_excludes: ["node_modules/**"], path_includes: ["test/**"], bash_allowlist: ["git status"] },
      ),
    ).toEqual({
      path_excludes: [".env", "node_modules/**"],
      path_includes: ["test/**"],
      bash_allowlist: ["git status"],
    })
  })

  test("TeamScope.checkBashCommand blocks unlisted command", () => {
    expect(TeamScope.checkBashCommand("git status", { bash_allowlist: ["bun test *"] }).allow).toBe(false)
  })

  test("spawnMember stores scope on member record", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const lead = await Session.create({})
        await seed(lead.id)
        await Team.create({ name: "phase4-scope-spawn", leadSessionID: lead.id })
        const loop = spyOn(SessionPrompt, "loop").mockResolvedValue(undefined as never)

        await Team.spawnMember({
          teamName: "phase4-scope-spawn",
          name: "worker",
          parentSessionID: lead.id,
          agent: { name: "general" },
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
          prompt: "Scoped task",
          planApproval: false,
          checkpoint: "none",
          scope: {
            path_excludes: [".ananke/**"],
            path_includes: ["src/**"],
            bash_allowlist: ["bun test *"],
          },
        })

        await Bun.sleep(20)

        const team = await Team.get("phase4-scope-spawn")
        expect(team?.members.find((item) => item.name === "worker")?.scope).toMatchObject({
          path_excludes: [".ananke/**", ".claude/**", ".opencode/**", ".git/**", "node_modules/**"],
          path_includes: ["src/**"],
          bash_allowlist: ["bun test *"],
        })

        loop.mockRestore()
        await finish("phase4-scope-spawn")
      },
    })
  })

  test("policy.pathAccess returns deny for excluded path", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const { lead, member } = await basic("phase4-policy-path")
        await Team.removeMember("phase4-policy-path", "worker")
        await Team.addMember("phase4-policy-path", {
          name: "worker",
          sessionID: member.id,
          agent: "general",
          status: "ready",
          checkpoint: "none",
          planApproval: "none",
          scope: { path_excludes: [".ananke/**"] },
        })

        const out = await TeamPolicy.pathAccess({
          teamName: "phase4-policy-path",
          memberName: "worker",
          filePath: path.join(tmp.path, ".ananke/session.json"),
          operation: "write",
        })
        expect(out.allow).toBe(false)

        await Team.setMemberStatus("phase4-policy-path", "worker", "shutdown")
        await Team.cleanup("phase4-policy-path")
        await Session.remove(SessionID.make(lead.id))
      },
    })
  })

  test("team_phase sets member phase in team record", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const { member } = await basic("phase4-phase")
        const out = await (await TeamPhaseTool.init()).execute({ phase: "testing" }, ctx(member.id))
        expect(out.title).toContain("Phase updated")
        expect((await Team.get("phase4-phase"))?.members.find((item) => item.name === "worker")?.phase).toBe("testing")

        await finish("phase4-phase")
      },
    })
  })

  test("team_status output includes phase and last_result_at", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const { lead, member } = await basic("phase4-status")
        await Team.removeMember("phase4-status", "worker")
        await Team.addMember("phase4-status", {
          name: "worker",
          sessionID: member.id,
          agent: "general",
          status: "ready",
          checkpoint: "none",
          planApproval: "none",
          phase: "testing",
          last_result_at: Date.now(),
          worktreeBranch: "team/phase4-status/worker",
        })
        await Team.setTeamPhase("phase4-status", "delivery")

        const out = await (await TeamStatusTool.init()).execute({}, ctx(lead.id))
        expect(out.output).toContain("phase=testing")
        expect(out.output).toContain("last_result=")
        expect(out.output).toContain("team_phase=delivery")
        expect(out.output).toContain("worktree=team/phase4-status/worker")

        await finish("phase4-status")
      },
    })
  })

  test("error status shows restart hint in rendered output", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const { lead, member } = await basic("phase4-error-hint")
        await Team.removeMember("phase4-error-hint", "worker")
        await Team.addMember("phase4-error-hint", {
          name: "worker",
          sessionID: member.id,
          agent: "general",
          status: "error",
          execution_status: "timed_out",
          checkpoint: "none",
          planApproval: "none",
          error_kind: "timeout",
        })

        const out = await (await TeamStatusTool.init()).execute({}, ctx(lead.id))
        expect(out.output).toContain("team_restart or team_shutdown")
        expect(out.output).toContain("review session log")
        expect(out.output).toContain("error_kind=timeout")

        await finish("phase4-error-hint")
      },
    })
  })

  test("timeout sets error_kind timeout on member record", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const lead = await Session.create({})
        await seed(lead.id)
        await Team.create({ name: "phase4-timeout", leadSessionID: lead.id })

        const waits: Array<() => Promise<void>> = []
        const timer = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => Promise<void>) => {
          waits.push(fn)
          return 1 as any
        }) as any)
        const loop = spyOn(SessionPrompt, "loop").mockImplementation((async () => new Promise(() => {})) as any)
        const cancel = spyOn(SessionPrompt, "cancel").mockResolvedValue()

        await Team.spawnMember({
          teamName: "phase4-timeout",
          name: "worker",
          parentSessionID: lead.id,
          agent: { name: "general" },
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
          prompt: "Wait forever",
          planApproval: false,
          checkpoint: "none",
          timeout: 1,
        })

        await waits[0]!()

        const team = await Team.get("phase4-timeout")
        const member = team?.members.find((item) => item.name === "worker")
        expect(member?.error_kind).toBe("timeout")
        expect(member?.execution_status).toBe("timed_out")
        expect(member?.status).toBe("error")

        cancel.mockRestore()
        loop.mockRestore()
        timer.mockRestore()
        await finish("phase4-timeout")
      },
    })
  })

  test("member_crashed sets error_kind member_crashed on member record", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const lead = await Session.create({})
        await seed(lead.id)
        await Team.create({ name: "phase4-crash", leadSessionID: lead.id })

        const loop = spyOn(SessionPrompt, "loop").mockRejectedValue(new Error("boom"))

        await Team.spawnMember({
          teamName: "phase4-crash",
          name: "worker",
          parentSessionID: lead.id,
          agent: { name: "general" },
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
          prompt: "Crash",
          planApproval: false,
          checkpoint: "none",
        })

        await Bun.sleep(20)

        const member = (await Team.get("phase4-crash"))?.members.find((item) => item.name === "worker")
        expect(member?.error_kind).toBe("member_crashed")
        expect(member?.status).toBe("error")

        loop.mockRestore()
        await finish("phase4-crash")
      },
    })
  })
})
