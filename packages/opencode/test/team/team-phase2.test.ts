import { describe, expect, spyOn, test } from "bun:test"
import { Env } from "../../src/env"
import { Inbox } from "../../src/team/inbox"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Team } from "../../src/team"
import { TeamMessaging } from "../../src/team/messaging"
import { TeamCreateTool } from "../../src/tool/team"
import { TeamReplyTool } from "../../src/tool/team"
import { TeamSpawnTool } from "../../src/tool/team"
import { TeamStatusTool } from "../../src/tool/team-status"
import { TeamDelegateTool } from "../../src/tool/team-delegate"
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
  return messageID
}

async function assist(sessionID: string, parentID: string) {
  const messageID = MessageID.ascending()
  await Session.updateMessage({
    id: messageID,
    sessionID: SessionID.make(sessionID),
    role: "assistant",
    parentID: MessageID.make(parentID),
    providerID: ProviderID.make("anthropic"),
    modelID: ModelID.make("claude-sonnet-4-20250514"),
    mode: "",
    agent: "general",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: { created: Date.now() },
  })
  return messageID
}

async function bill(sessionID: string, parentID: string, cost: number) {
  await Session.updateMessage({
    id: MessageID.ascending(),
    sessionID: SessionID.make(sessionID),
    role: "assistant",
    parentID: MessageID.make(parentID),
    providerID: ProviderID.make("anthropic"),
    modelID: ModelID.make("claude-sonnet-4-20250514"),
    mode: "",
    agent: "general",
    path: { cwd: "/", root: "/" },
    cost,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: { created: Date.now() },
  })
}

function ctx(
  sessionID: string,
  messageID = MessageID.ascending(),
  messages: Array<{ info: { role: string; model?: { providerID: string; modelID: string } } }> = [],
) {
  return {
    sessionID,
    messageID,
    agent: "general",
    abort: new AbortController().signal,
    messages,
    metadata: () => {},
    ask: async () => {},
  } as any
}

describe("team phase 2", () => {
  test("team_delegate tracks active delegations and can relay a summary to the lead", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const lead = await Session.create({})
        const member = await Session.create({ parentID: lead.id })
        await seed(lead.id)
        const memberSeed = await seed(member.id)
        const memberMsg = await assist(member.id, memberSeed)

        await Team.create({ name: "phase2-delegate", leadSessionID: lead.id })
        await Team.addMember("phase2-delegate", {
          name: "worker",
          sessionID: member.id,
          agent: "general",
          status: "ready",
          checkpoint: "none",
          planApproval: "none",
        })

        let done!: (value: any) => void
        const wait = new Promise((resolve) => {
          done = resolve
        })
        const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async () => {
          return (await wait) as any
        }) as any)

        const tool = await TeamDelegateTool.init()
        const run = tool.execute(
          {
            description: "schema check",
            prompt: "Validate the API schema",
            agent: "explore",
            post_to_lead: true,
          },
          ctx(member.id, memberMsg, await Session.messages({ sessionID: member.id })),
        )

        await Bun.sleep(20)

        const team = await Team.get("phase2-delegate")
        expect(team?.members.find((item) => item.name === "worker")?.activeDelegations).toBe(1)

        const status = await (await TeamStatusTool.init()).execute({}, ctx(lead.id))
        expect(status.output).toContain("delegations=1")

        done({ parts: [{ type: "text", text: "Delegate finished cleanly" }] })
        const result = await run
        expect(result.output).toContain("Delegate finished cleanly")
        expect(await Team.trace(result.metadata.sessionId)).toEqual({
          parentTeam: "phase2-delegate",
          parentMember: "worker",
          mode: "delegate",
        })

        const final = await Team.get("phase2-delegate")
        expect(final?.members.find((item) => item.name === "worker")?.activeDelegations).toBe(0)

        const leadUnread = await Inbox.unread("phase2-delegate", "lead")
        expect(leadUnread.some((item) => item.text.includes("Delegate finished cleanly"))).toBe(true)

        prompt.mockRestore()
        await Team.setMemberStatus("phase2-delegate", "worker", "shutdown")
        await Team.cleanup("phase2-delegate")
      },
    })
  })

  test("low-priority messages queue, replies preserve threads, and urgent messages are marked", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const lead = await Session.create({})
        const member = await Session.create({ parentID: lead.id })
        await seed(lead.id)
        await seed(member.id)

        await Team.create({ name: "phase2-msg", leadSessionID: lead.id })
        await Team.addMember("phase2-msg", {
          name: "worker",
          sessionID: member.id,
          agent: "general",
          status: "busy",
          execution_status: "running",
          checkpoint: "none",
          planApproval: "none",
        })

        await TeamMessaging.send({
          teamName: "phase2-msg",
          from: "lead",
          to: "worker",
          text: "Background note",
          type: "status",
          priority: "low",
        })

        const queued = await Inbox.unread("phase2-msg", "worker")
        expect(queued).toHaveLength(1)
        expect(queued[0]?.priority).toBe("low")
        expect(queued[0]?.type).toBe("status")

        const before = await Session.messages({ sessionID: member.id })
        expect(
          before.some((msg) => msg.parts.some((part) => part.type === "text" && part.text.includes("Background note"))),
        ).toBe(false)

        const loop = spyOn(SessionPrompt, "loop").mockResolvedValue(undefined as never)
        await Team.transitionExecutionStatus("phase2-msg", "worker", "idle", { force: true })
        await Team.transitionMemberStatus("phase2-msg", "worker", "ready", { force: true })
        await Bun.sleep(20)

        const after = await Session.messages({ sessionID: member.id })
        expect(
          after.some((msg) => msg.parts.some((part) => part.type === "text" && part.text.includes("Background note"))),
        ).toBe(true)

        const sent = await Inbox.all("phase2-msg", "worker")
        const root = sent.find((item) => item.text === "Background note")
        expect(root?.threadId).toBeTruthy()

        const reply = await (
          await TeamReplyTool.init()
        ).execute(
          {
            text: "Handled",
            type: "result",
          },
          ctx(member.id, undefined, await Session.messages({ sessionID: member.id })),
        )
        expect(reply.title).toContain("Reply sent")

        const leadInbox = await Inbox.all("phase2-msg", "lead")
        const last = leadInbox.findLast((item) => item.text === "Handled")
        expect(last?.replyTo).toBe(root?.id)
        expect(last?.threadId).toBe(root?.threadId)
        expect(last?.type).toBe("result")

        await TeamMessaging.send({
          teamName: "phase2-msg",
          from: "lead",
          to: "worker",
          text: "Need eyes now",
          priority: "urgent",
          type: "question",
        })
        const urgent = await Inbox.all("phase2-msg", "worker")
        expect(urgent.some((item) => item.text.includes("[URGENT] Need eyes now") && item.priority === "urgent")).toBe(
          true,
        )

        const status = await (await TeamStatusTool.init()).execute({}, ctx(lead.id))
        expect(status.output).toContain("Threads")
        expect(status.output).toContain("Handled")

        loop.mockRestore()
        await Team.setMemberStatus("phase2-msg", "worker", "shutdown")
        await Team.cleanup("phase2-msg")
      },
    })
  })

  test("team_spawn forwards max_cost to the spawn workflow", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const lead = await Session.create({})
        await seed(lead.id)
        await Team.create({ name: "phase2-spawn", leadSessionID: lead.id })

        const spawn = spyOn(Team, "spawnMember").mockResolvedValue({
          sessionID: "ses_spawned",
          label: "openai/gpt-4.1",
        })

        const tool = await TeamSpawnTool.init()
        const result = await tool.execute(
          {
            name: "worker",
            agent: "explore",
            prompt: "Review the schema",
            checkpoint: "none",
            max_cost: 1.25,
          },
          ctx(lead.id, undefined, await Session.messages({ sessionID: lead.id })),
        )

        expect(result.title).toBe("Spawned teammate: worker")
        expect(result.output).toContain("Stay in LEAD MODE while this team is active")
        expect(result.output).toContain("team_status")
        expect(result.metadata).toMatchObject({
          memberName: "worker",
          sessionId: "ses_spawned",
        })
        expect("sessionID" in result.metadata).toBe(false)
        expect(spawn).toHaveBeenCalledWith(
          expect.objectContaining({
            teamName: "phase2-spawn",
            name: "worker",
            maxCost: 1.25,
          }),
        )

        spawn.mockRestore()
        await Team.cleanup("phase2-spawn")
      },
    })
  })

  test("team_create stores a team budget cap and traced child spend triggers auto-pause", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const lead = await Session.create({})
        const worker = await Session.create({ parentID: lead.id })
        await seed(lead.id)

        const create = await (
          await TeamCreateTool.init()
        ).execute(
          {
            name: "phase2-team-cap",
            max_cost: 0.01,
          },
          ctx(lead.id),
        )
        expect(create.output).toContain("Team budget cap: $0.01")

        await Team.addMember("phase2-team-cap", {
          name: "worker",
          sessionID: worker.id,
          agent: "general",
          status: "ready",
          checkpoint: "none",
          planApproval: "none",
        })

        const child = await Session.create({ parentID: worker.id })
        const root = await seed(child.id, "child seed")
        await Team.setTrace(child.id, {
          parentTeam: "phase2-team-cap",
          parentMember: "worker",
          mode: "task",
        })

        const stop = Team.monitorCosts({ delay: 5 })
        await bill(child.id, root, 0.02)
        await Bun.sleep(30)

        const team = await Team.get("phase2-team-cap")
        expect(team?.maxCost).toBe(0.01)
        expect(team?.members.find((item) => item.name === "worker")?.status).toBe("paused")
        expect(await Team.trace(child.id)).toEqual({
          parentTeam: "phase2-team-cap",
          parentMember: "worker",
          mode: "task",
        })

        const leadUnread = await Inbox.unread("phase2-team-cap", "lead")
        expect(leadUnread.some((item) => item.text.includes("paused all members") && item.text.includes("$0.02"))).toBe(
          true,
        )

        stop()
        await Team.setMemberStatus("phase2-team-cap", "worker", "shutdown")
        await Team.cleanup("phase2-team-cap")
      },
    })
  })

  test("member cost limits pause workers and team_status shows budget details", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const lead = await Session.create({})
        const worker = await Session.create({ parentID: lead.id })
        const helper = await Session.create({ parentID: lead.id })
        await seed(lead.id)
        await seed(helper.id)

        await Team.create({ name: "phase2-budget", leadSessionID: lead.id })
        await Team.addMember("phase2-budget", {
          name: "worker",
          sessionID: worker.id,
          agent: "general",
          status: "ready",
          checkpoint: "none",
          planApproval: "none",
          maxCost: 0.01,
        })
        await Team.addMember("phase2-budget", {
          name: "helper",
          sessionID: helper.id,
          agent: "general",
          status: "ready",
          checkpoint: "none",
          planApproval: "none",
          maxCost: 1,
        })

        const stop = Team.monitorCosts({ delay: 5 })
        const workSeed = await seed(worker.id, "worker cost seed")
        await bill(worker.id, workSeed, 0.02)
        await Bun.sleep(30)

        const team = await Team.get("phase2-budget")
        expect(team?.members.find((item) => item.name === "worker")?.status).toBe("paused")
        expect(team?.members.find((item) => item.name === "helper")?.status).toBe("ready")

        const leadUnread = await Inbox.unread("phase2-budget", "lead")
        expect(leadUnread.some((item) => item.text.includes("worker") && item.text.includes("$0.02"))).toBe(true)

        const status = await (await TeamStatusTool.init()).execute({}, ctx(lead.id))
        expect(status.output).toContain("Costs:")
        expect(status.output).toContain("Budget usage:")
        expect(status.output).toContain("projected 1h")

        stop()
        await Team.setMemberStatus("phase2-budget", "worker", "shutdown")
        await Team.setMemberStatus("phase2-budget", "helper", "shutdown")
        await Team.cleanup("phase2-budget")
      },
    })
  })
})
