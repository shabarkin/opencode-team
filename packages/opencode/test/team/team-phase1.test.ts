import { describe, expect, spyOn, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Env } from "../../src/env"
import { Log } from "../../src/util/log"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Team } from "../../src/team"
import { TeamMessaging } from "../../src/team/messaging"
import { TeamRequestSpawnTool, TeamShutdownTool, TeamSpawnTool } from "../../src/tool/team"
import { Inbox } from "../../src/team/inbox"
import { MessageV2 } from "../../src/session/message-v2"
import { Bus } from "../../src/bus"
import { Plugin } from "../../src/plugin"
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

describe("team phase 1", () => {
  test("paused members queue messages until resume", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const lead = await Session.create({})
        const member = await Session.create({ parentID: lead.id })
        await seed(lead.id)
        await seed(member.id)

        await Team.create({ name: "phase1-pause", leadSessionID: lead.id })
        await Team.addMember("phase1-pause", {
          name: "worker",
          sessionID: member.id,
          agent: "general",
          status: "ready",
          checkpoint: "none",
          planApproval: "none",
        })

        await Team.pause({ teamName: "phase1-pause", memberName: "worker" })
        await TeamMessaging.send({ teamName: "phase1-pause", from: "lead", to: "worker", text: "queued note" })

        const unread = await Inbox.unread("phase1-pause", "worker")
        expect(unread).toHaveLength(1)
        expect(unread[0]?.text).toBe("queued note")

        const before = await Session.messages({ sessionID: member.id })
        expect(
          before.some((msg) => msg.parts.some((part) => part.type === "text" && part.text.includes("queued note"))),
        ).toBe(false)

        const loop = spyOn(SessionPrompt, "loop").mockResolvedValue(undefined as never)
        await Team.resume({ teamName: "phase1-pause", memberName: "worker", redirect: "continue now" })
        await Bun.sleep(20)

        const after = await Session.messages({ sessionID: member.id })
        expect(
          after.some((msg) => msg.parts.some((part) => part.type === "text" && part.text.includes("queued note"))),
        ).toBe(true)
        expect(
          after.some((msg) => msg.parts.some((part) => part.type === "text" && part.text.includes("continue now"))),
        ).toBe(true)

        loop.mockRestore()
        await Team.setMemberStatus("phase1-pause", "worker", "shutdown")
        await Team.cleanup("phase1-pause")
      },
    })
  })

  test("checkpoint mode pauses after write tools and notifies the lead", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const stop = Team.checkpoints()
        const loop = spyOn(SessionPrompt, "loop").mockResolvedValue(undefined as never)
        const lead = await Session.create({})
        const member = await Session.create({ parentID: lead.id })
        await seed(lead.id)
        await seed(member.id)

        await Team.create({ name: "phase1-checkpoint", leadSessionID: lead.id })
        await Team.addMember("phase1-checkpoint", {
          name: "worker",
          sessionID: member.id,
          agent: "general",
          status: "busy",
          execution_status: "running",
          checkpoint: "after_each_write",
          planApproval: "none",
        })

        await Bus.publish(MessageV2.Event.PartUpdated, {
          part: {
            id: PartID.ascending(),
            messageID: MessageID.ascending(),
            sessionID: SessionID.make(member.id),
            type: "tool",
            callID: "call_write_1",
            tool: "write",
            state: {
              status: "completed",
              input: {},
              output: "ok",
              title: "Write",
              metadata: {},
              time: { start: Date.now() - 10, end: Date.now() },
            },
          },
        })
        await Bun.sleep(20)

        const team = await Team.get("phase1-checkpoint")
        expect(team?.members.find((item) => item.name === "worker")?.status).toBe("paused")

        const leadMsgs = await Session.messages({ sessionID: lead.id })
        expect(
          leadMsgs.some((msg) =>
            msg.parts.some((part) => part.type === "text" && part.text.includes("Checkpoint reached")),
          ),
        ).toBe(true)

        stop()
        loop.mockRestore()
        await Team.setMemberStatus("phase1-checkpoint", "worker", "shutdown")
        await Team.cleanup("phase1-checkpoint")
      },
    })
  })

  test("spawn requests can be queued for approval and approved by the lead", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const lead = await Session.create({})
        const member = await Session.create({ parentID: lead.id })
        await seed(lead.id)
        await seed(member.id)

        await Team.create({ name: "phase1-request", leadSessionID: lead.id })
        await Team.addMember("phase1-request", {
          name: "worker",
          sessionID: member.id,
          agent: "general",
          status: "ready",
          checkpoint: "none",
          planApproval: "none",
        })

        const requestTool = await TeamRequestSpawnTool.init()
        const requested = await requestTool.execute(
          {
            agent: "explore",
            name: "scout",
            rationale: "Need extra research capacity",
            prompt: "Research the open questions",
          },
          ctx(member.id, await Session.messages({ sessionID: member.id })),
        )
        const requestID = requested.metadata.requestID as string
        expect(requestID).toBeTruthy()
        expect((await Team.listSpawnRequests("phase1-request")).map((item) => item.id)).toContain(requestID)

        const spawn = spyOn(SessionPrompt, "loop").mockResolvedValue(undefined as never)
        const spawnTool = await TeamSpawnTool.init()
        const approved = await spawnTool.execute(
          {
            from_request: requestID,
            checkpoint: "none",
          },
          ctx(lead.id, await Session.messages({ sessionID: lead.id })),
        )

        expect(approved.title).toContain("Spawned teammate")
        expect(await Team.listSpawnRequests("phase1-request")).toEqual([])

        const team = await Team.get("phase1-request")
        expect(team?.members.some((item) => item.name === "scout")).toBe(true)

        spawn.mockRestore()
        await Team.setMemberStatus("phase1-request", "worker", "shutdown")
        await Team.setMemberStatus("phase1-request", "scout", "shutdown")
        await Team.cleanup("phase1-request")
      },
    })
  })

  test("team policy hooks can rewrite messages and block spawn and shutdown", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const trigger = spyOn(Plugin, "trigger").mockImplementation(async (name, _input, output) => {
          if (name === "team.message.sending") {
            ;(output as { text: string }).text = `[hook] ${(output as { text: string }).text}`
          }
          if (name === "team.member.spawning") {
            ;(output as { allow: boolean; reason?: string }).allow = false
            ;(output as { allow: boolean; reason?: string }).reason = "Spawn denied by test policy"
          }
          if (name === "team.shutdown.before") {
            ;(output as { allow: boolean; reason?: string }).allow = false
            ;(output as { allow: boolean; reason?: string }).reason = "Shutdown denied by test policy"
          }
          return output as any
        })

        const lead = await Session.create({})
        const member = await Session.create({ parentID: lead.id })
        await seed(lead.id)
        await seed(member.id)

        await Team.create({ name: "phase1-policy", leadSessionID: lead.id })
        await Team.addMember("phase1-policy", {
          name: "worker",
          sessionID: member.id,
          agent: "general",
          status: "ready",
          checkpoint: "none",
          planApproval: "none",
        })

        await TeamMessaging.send({ teamName: "phase1-policy", from: "lead", to: "worker", text: "hello" })
        const memberMsgs = await Session.messages({ sessionID: member.id })
        expect(
          memberMsgs.some((msg) =>
            msg.parts.some((part) => part.type === "text" && part.text.includes("[hook] hello")),
          ),
        ).toBe(true)

        await expect(
          Team.spawnMember({
            teamName: "phase1-policy",
            name: "blocked",
            parentSessionID: lead.id,
            requestedBy: "lead",
            agent: { name: "general" },
            model: { providerID: "openai", modelID: "gpt-4.1" },
            prompt: "blocked",
            planApproval: false,
            checkpoint: "none",
          }),
        ).rejects.toThrow("Spawn denied by test policy")

        const shutdown = await (
          await TeamShutdownTool.init()
        ).execute({ name: "worker" }, ctx(lead.id, await Session.messages({ sessionID: lead.id })))
        expect(shutdown.title).toBe("Shutdown blocked")
        expect(shutdown.output).toContain("Shutdown denied by test policy")

        trigger.mockRestore()
        await Team.setMemberStatus("phase1-policy", "worker", "shutdown")
        await Team.cleanup("phase1-policy")
      },
    })
  })
})
