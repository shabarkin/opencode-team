import { describe, expect, spyOn, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { SessionRoutes } from "../../src/server/routes/session"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { Team } from "../../src/team"
import { Inbox } from "../../src/team/inbox"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

async function seed(sessionID: SessionID, text = "seed") {
  const id = MessageID.ascending()
  await Session.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "build",
  } as unknown as MessageV2.Info)
  await Session.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: id,
    type: "text",
    text,
  })
}

describe("session team routes", () => {
  test("steer forwards instructions to session prompt", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const steer = spyOn(SessionPrompt, "steer").mockResolvedValue()

        const app = SessionRoutes()
        const res = await app.request(`/${session.id}/steer`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-opencode-session": session.id,
          },
          body: JSON.stringify({ text: "focus on the failing tests" }),
        })

        expect(res.status).toBe(200)
        expect(await res.json()).toBe(true)
        expect(steer).toHaveBeenCalledWith(session.id, "focus on the failing tests")

        steer.mockRestore()
      },
    })
  })

  test("steer requires a matching caller session", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const other = await Session.create({})
        const steer = spyOn(SessionPrompt, "steer").mockResolvedValue()

        const app = SessionRoutes()
        const res = await app.request(`/${session.id}/steer`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-opencode-session": other.id,
          },
          body: JSON.stringify({ text: "focus on the failing tests" }),
        })

        expect(res.status).toBe(403)
        expect(steer).not.toHaveBeenCalled()

        steer.mockRestore()
      },
    })
  })

  test("team-message sends to teammate inbox and session", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const lead = (await Session.create({})).id
        const member = (await Session.create({ parentID: lead })).id
        await seed(lead, "lead")
        await seed(member, "member")
        await Team.create({ name: "msg-team", leadSessionID: lead })
        await Team.addMember("msg-team", {
          name: "worker-a",
          sessionID: member,
          agent: "general",
          status: "ready",
        })

        const app = SessionRoutes()
        const res = await app.request(`/${lead}/team-message`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ to: "worker-a", text: "please check this" }),
        })

        expect(res.status).toBe(200)
        expect(await res.json()).toBe(true)

        const unread = await Inbox.unread("msg-team", "worker-a")
        expect(unread).toHaveLength(1)
        expect(unread[0].from).toBe("lead")
        expect(unread[0].text).toBe("please check this")

        const msgs = await Session.messages({ sessionID: member })
        const part = msgs.at(-1)?.parts.find((item) => item.type === "text")
        expect(part?.type).toBe("text")
        if (part?.type === "text") {
          expect(part.synthetic).toBe(true)
          expect(part.text).toContain("[Team message from lead]: please check this")
        }
      },
    })
  })

  test("abort propagates from lead to busy teammates", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const lead = (await Session.create({})).id
        const member = (await Session.create({ parentID: lead })).id
        await Team.create({ name: "abort-team", leadSessionID: lead })
        await Team.addMember("abort-team", {
          name: "worker-a",
          sessionID: member,
          agent: "general",
          status: "busy",
          execution_status: "running",
        })

        const app = SessionRoutes()
        const res = await app.request(`/${lead}/abort`, {
          method: "POST",
        })

        expect(res.status).toBe(200)
        expect(await res.json()).toBe(true)

        const team = await Team.get("abort-team")
        expect(team?.members[0].execution_status).toBe("cancelling")
      },
    })
  })
})
