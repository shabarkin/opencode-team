import { describe, expect, spyOn, test } from "bun:test"
import { Env } from "../../src/env"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Team, WRITE_TOOLS } from "../../src/team"
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

async function finish(name: string) {
  const team = await Team.get(name)
  if (!team) return
  for (const member of team.members) {
    await Team.setMemberStatus(name, member.name, "shutdown")
  }
  await Team.cleanup(name).catch(() => undefined)
}

describe("team mode", () => {
  test("research mode denies write tools and stores the member mode", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const lead = await Session.create({})
        await seed(lead.id)
        await Team.create({ name: "research-mode", leadSessionID: lead.id })

        const loop = spyOn(SessionPrompt, "loop").mockResolvedValue(undefined as never)
        const out = await Team.spawnMember({
          teamName: "research-mode",
          name: "worker",
          parentSessionID: lead.id,
          agent: { name: "general" },
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
          prompt: "Research only.",
          mode: "research",
          planApproval: false,
          checkpoint: "none",
          resultDeadline: 5,
        })

        await Bun.sleep(20)

        const team = await Team.get("research-mode")
        const member = team?.members.find((item) => item.name === "worker")
        expect(member?.mode).toBe("research")
        expect(member?.result_deadline).toBe(5)

        const session = await Session.get(SessionID.make(out.sessionID))
        for (const tool of WRITE_TOOLS) {
          expect(session.permission).toContainEqual({ permission: tool, pattern: "*:research-mode", action: "deny" })
        }

        loop.mockRestore()
        await finish("research-mode")
      },
    })
  })

  test("result deadlines warn the teammate and notify the lead when missed", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const lead = await Session.create({})
        await seed(lead.id)
        await Team.create({ name: "deadline-mode", leadSessionID: lead.id })

        const waits: Array<() => Promise<void>> = []
        const timer = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => Promise<void>) => {
          waits.push(fn)
          return 1 as any
        }) as any)
        const loop = spyOn(SessionPrompt, "loop").mockResolvedValue(undefined as never)
        const send = spyOn(TeamMessaging, "send").mockResolvedValue()

        await Team.spawnMember({
          teamName: "deadline-mode",
          name: "worker",
          parentSessionID: lead.id,
          agent: { name: "general" },
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
          prompt: "Research only.",
          mode: "research",
          planApproval: false,
          checkpoint: "none",
          resultDeadline: 5,
        })

        expect(waits).toHaveLength(2)
        await waits[0]!()
        await waits[1]!()

        expect(send).toHaveBeenNthCalledWith(1, {
          teamName: "deadline-mode",
          from: "system",
          to: "worker",
          text: "DEADLINE WARNING: Submit your result NOW using team_submit_result.",
          priority: "urgent",
        })
        expect(send).toHaveBeenNthCalledWith(2, {
          teamName: "deadline-mode",
          from: "system",
          to: "lead",
          text: 'DEADLINE EXPIRED: "worker" did not submit within 5 min.',
          priority: "urgent",
        })

        send.mockRestore()
        loop.mockRestore()
        timer.mockRestore()
        await Team.forceShutdownAll("deadline-mode")
        await Team.cleanup("deadline-mode")
      },
    })
  })
})
