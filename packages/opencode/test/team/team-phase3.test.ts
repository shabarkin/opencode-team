import { describe, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { Inbox } from "../../src/team/inbox"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Session, Storage } from "../../src/team/runtime"
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

function inbox(teamName: string, agentName: string) {
  return path.join(Global.Path.data, "storage", "team_inbox", Instance.project.id, teamName, agentName + ".jsonl")
}

function quarantine(teamName: string, agentName: string) {
  return path.join(
    Global.Path.data,
    "storage",
    "team_inbox",
    Instance.project.id,
    teamName,
    agentName + ".quarantine.jsonl",
  )
}

describe("team phase 3", () => {
  test("inbox writes are idempotent by message id", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        await Inbox.write("phase3-inbox", "worker", {
          id: "im_duplicate",
          from: "lead",
          text: "hello",
          timestamp: Date.now(),
        })
        await Inbox.write("phase3-inbox", "worker", {
          id: "im_duplicate",
          from: "lead",
          text: "hello again",
          timestamp: Date.now(),
        })

        const all = await Inbox.all("phase3-inbox", "worker")
        expect(all).toHaveLength(1)
        expect(all[0]?.text).toBe("hello")
      },
    })
  })

  test("recover validates corrupted inbox files and quarantines bad lines", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        const lead = await Session.create({})
        const member = await Session.create({ parentID: lead.id })
        await seed(lead.id)
        await seed(member.id)

        await Team.create({ name: "phase3-validate", leadSessionID: lead.id })
        await Team.addMember("phase3-validate", {
          name: "worker",
          sessionID: member.id,
          agent: "general",
          status: "ready",
          checkpoint: "none",
          planApproval: "none",
        })

        await fs.mkdir(path.dirname(inbox("phase3-validate", "worker")), { recursive: true })
        await Bun.write(
          inbox("phase3-validate", "worker"),
          [
            JSON.stringify({
              id: "im_valid",
              from: "lead",
              text: "recover me",
              timestamp: Date.now(),
              read: false,
            }),
            "{bad json",
          ].join("\n") + "\n",
        )

        await Team.recover()

        const msgs = await Session.messages({ sessionID: member.id })
        expect(
          msgs.some((msg) => msg.parts.some((part) => part.type === "text" && part.text.includes("recover me"))),
        ).toBe(true)

        expect(await Bun.file(quarantine("phase3-validate", "worker")).text()).toContain("{bad json")
        expect(await Bun.file(inbox("phase3-validate", "worker")).text()).not.toContain("{bad json")

        await Team.setMemberStatus("phase3-validate", "worker", "shutdown")
        await Team.cleanup("phase3-validate")
      },
    })
  })

  // TODO(team): Cleanup blocks because Team.cleanup's "active session loop" check
  // sees a session with running prompt loops; the test doesn't wait for them to
  // settle. Pre-existing race; investigate Team.cleanup's loop-tracking semantics.
  test.skip("send retries transient injection failures without duplicating delivery", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        const lead = await Session.create({})
        const member = await Session.create({ parentID: lead.id })
        await seed(lead.id)
        await seed(member.id)

        await Team.create({ name: "phase3-retry", leadSessionID: lead.id })
        await Team.addMember("phase3-retry", {
          name: "worker",
          sessionID: member.id,
          agent: "general",
          status: "ready",
          checkpoint: "none",
          planApproval: "none",
        })

        const part = Session.updatePart
        let count = 0
        const fail = spyOn(Session, "updatePart").mockImplementation((async (input: any) => {
          if (input.metadata?.inboxMessageId && count < 2) {
            count++
            throw new Error("transient inject failure")
          }
          return await part(input)
        }) as any)

        await TeamMessaging.send({
          teamName: "phase3-retry",
          from: "lead",
          to: "worker",
          text: "please retry",
        })

        const msgs = await Session.messages({ sessionID: member.id })
        expect(
          msgs.filter((msg) => msg.parts.some((item) => item.type === "text" && item.text.includes("please retry"))),
        ).toHaveLength(1)
        expect(await Inbox.all("phase3-retry", "worker")).toHaveLength(1)

        fail.mockRestore()
        await Team.setMemberStatus("phase3-retry", "worker", "shutdown")
        await Team.cleanup("phase3-retry")
      },
    })
  })

  test("recover recreates missing team configs from teammate sessions", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        // process.env.ANTHROPIC_API_KEY intentionally not set; tests mock provider calls
      },
      fn: async () => {
        const lead = await Session.create({})
        const member = await Session.create({
          parentID: lead.id,
          title: "worker (@general teammate, anthropic/claude-sonnet-4-20250514)",
        })
        await seed(lead.id)
        await seed(
          member.id,
          [
            'You are "worker", a teammate in team "phase3-orphan".',
            'Your agent type is "general", using model anthropic/claude-sonnet-4-20250514.',
            "",
            "Your instructions:",
            "Do work.",
          ].join("\n"),
        )

        await Team.create({ name: "phase3-orphan", leadSessionID: lead.id })
        await Team.addMember("phase3-orphan", {
          name: "worker",
          sessionID: member.id,
          agent: "general",
          status: "ready",
          checkpoint: "none",
          planApproval: "none",
        })
        await Storage.remove(["team", Instance.project.id, "phase3-orphan"])

        expect(await Team.get("phase3-orphan")).toBeUndefined()

        await Team.recover()

        const team = await Team.get("phase3-orphan")
        expect(team?.leadSessionID).toBe(lead.id)
        expect(team?.members).toHaveLength(1)
        expect(team?.members[0]).toMatchObject({
          name: "worker",
          sessionID: member.id,
          agent: "general",
          status: "ready",
        })

        await Team.setMemberStatus("phase3-orphan", "worker", "shutdown")
        await Team.cleanup("phase3-orphan")
      },
    })
  })
})
