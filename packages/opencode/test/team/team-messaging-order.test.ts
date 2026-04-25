import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/team/runtime"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Team } from "../../src/team"
import { Inbox } from "../../src/team/inbox"
import { TeamMessaging } from "../../src/team/messaging"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { tmpdir } from "../fixture/fixture"

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

describe("team messaging order", () => {
  test("preserves the original inbox timestamp and session ids on delayed delivery", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        process.env.ANTHROPIC_API_KEY = "test-key"
      },
      fn: async () => {
        const lead = await Session.create({})
        const member = await Session.create({ parentID: lead.id })
        await seed(lead.id)
        await seed(member.id)

        await Team.create({ name: "order-team", leadSessionID: lead.id })
        await Team.addMember("order-team", {
          name: "worker",
          sessionID: member.id,
          agent: "general",
          status: "paused",
          checkpoint: "none",
          planApproval: "none",
        })

        await TeamMessaging.send({
          teamName: "order-team",
          from: "lead",
          to: "worker",
          text: "keep chronology",
        })

        const inbox = await Inbox.all("order-team", "worker")
        expect(inbox).toHaveLength(1)
        expect(inbox[0]?.sessionMessageID).toBeDefined()
        expect(inbox[0]?.sessionPartID).toBeDefined()
        const msgID = inbox[0]!.sessionMessageID!
        const partID = inbox[0]!.sessionPartID!
        const stamp = inbox[0]!.timestamp

        await Bun.sleep(5)
        await TeamMessaging.recoverInbox("order-team", "worker", member.id)

        const msgs = await Session.messages({ sessionID: member.id })
        const injected = msgs.find((msg) =>
          msg.parts.some((part) => part.type === "text" && part.text.includes("keep chronology")),
        )

        expect(String(injected?.info.id)).toBe(msgID)
        expect(injected?.info.time.created).toBe(stamp)
        expect(String(injected?.parts.find((part) => part.type === "text")?.id)).toBe(partID)

        await Team.setMemberStatus("order-team", "worker", "shutdown")
        await Team.cleanup("order-team")
      },
    })
  })
})
