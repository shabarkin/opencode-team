import { describe, expect, spyOn, test } from "bun:test"
import { Inbox } from "../../src/team/inbox"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Session, SessionPrompt } from "../../src/team/runtime"
import { Team } from "../../src/team"
import { TeamMessaging } from "../../src/team/messaging"
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

async function basic(name: string, receipts?: boolean) {
  const lead = await Session.create({})
  const member = await Session.create({ parentID: lead.id })
  await seed(lead.id)
  await seed(member.id)
  await Team.create({ name, leadSessionID: lead.id, receipts })
  await Team.addMember(name, {
    name: "worker",
    sessionID: member.id,
    agent: "general",
    status: "ready",
    execution_status: "idle",
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

describe("team messaging filter", () => {
  test("low-priority system messages stay in the inbox but are not injected", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        process.env.ANTHROPIC_API_KEY = "test-key"
      },
      fn: async () => {
        const loop = spyOn(SessionPrompt, "loop").mockResolvedValue(undefined as never)
        const { member } = await basic("messaging-filter")

        await TeamMessaging.send({
          teamName: "messaging-filter",
          from: "system",
          to: "worker",
          text: "quiet notice",
          type: "system",
          priority: "low",
        })

        expect(await Inbox.all("messaging-filter", "worker")).toHaveLength(1)
        expect(
          (await Session.messages({ sessionID: SessionID.make(member.id) })).some((msg) =>
            msg.parts.some((part) => part.type === "text" && part.text.includes("quiet notice")),
          ),
        ).toBe(false)
        expect(loop).not.toHaveBeenCalled()

        loop.mockRestore()
        await finish("messaging-filter")
      },
    })
  })

  test("markRead skips receipts unless the team opts in", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        process.env.ANTHROPIC_API_KEY = "test-key"
      },
      fn: async () => {
        await basic("receipts-off")

        await TeamMessaging.send({
          teamName: "receipts-off",
          from: "lead",
          to: "worker",
          text: "please read this",
        })
        expect(await TeamMessaging.markRead("receipts-off", "worker")).toBe(1)
        expect(await Inbox.all("receipts-off", "lead")).toHaveLength(0)

        await finish("receipts-off")
      },
    })
  })

  test("opt-in receipts are recorded but still not injected as low-priority system messages", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        process.env.ANTHROPIC_API_KEY = "test-key"
      },
      fn: async () => {
        const loop = spyOn(SessionPrompt, "loop").mockResolvedValue(undefined as never)
        const { lead } = await basic("receipts-on", true)

        await TeamMessaging.send({
          teamName: "receipts-on",
          from: "lead",
          to: "worker",
          text: "please read this",
        })
        await Bun.sleep(20)
        const calls = loop.mock.calls.length
        expect(await TeamMessaging.markRead("receipts-on", "worker")).toBe(1)
        await Bun.sleep(20)

        const items = await Inbox.all("receipts-on", "lead")
        expect(items).toHaveLength(1)
        expect(items[0]?.text).toContain("[receipt] worker has read your message")
        expect(
          (await Session.messages({ sessionID: SessionID.make(lead.id) })).some((msg) =>
            msg.parts.some(
              (part) => part.type === "text" && part.text.includes("[receipt] worker has read your message"),
            ),
          ),
        ).toBe(false)
        expect(loop).toHaveBeenCalledTimes(calls)

        loop.mockRestore()
        await finish("receipts-on")
      },
    })
  })
})
