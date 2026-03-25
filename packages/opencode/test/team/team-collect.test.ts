import { describe, expect, spyOn, test } from "bun:test"
import { Env } from "../../src/env"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session"
import { Team } from "../../src/team"
import { TeamCollectTool } from "../../src/tool/team-collect"
import { TeamSubmitResultTool } from "../../src/tool/team-inbox"
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

async function basic(name: string, status: "ready" | "busy" | "shutdown" = "busy") {
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

describe("team collect", () => {
  test("team_collect waits for a structured result and marks synthesis ready", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const sleep = spyOn(Bun, "sleep").mockImplementation((async () => undefined) as any)
        const { lead, member } = await basic("collect-ready")

        const wait = (await TeamCollectTool.init()).execute(
          { timeout_seconds: 10, poll_interval_seconds: 5 },
          ctx(lead.id),
        )

        await (
          await TeamSubmitResultTool.init()
        ).execute(
          {
            title: "Audit complete",
            summary: "All requested checks are done.",
            status: "success",
          },
          ctx(member.id),
        )

        const out = await wait
        expect(out.metadata).toMatchObject({ collected: ["worker"], pending: [], timed_out: false })
        expect(out.output).toContain("Audit complete")
        expect(out.output).toContain("Produce your final synthesis ONCE")

        const team = await Team.get("collect-ready")
        expect(team?.team_phase).toBe("synthesis")
        expect(team?.delivered).toBe(true)

        const status = await (await TeamStatusTool.init()).execute({}, ctx(lead.id))
        expect(status.output).toContain("team_phase=synthesis")

        sleep.mockRestore()
        await finish("collect-ready")
      },
    })
  })

  test("team_collect treats ready members without results as collected", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const { lead } = await basic("collect-ready-no-result", "ready")
        const out = await (await TeamCollectTool.init()).execute({ members: ["worker"] }, ctx(lead.id))

        expect(out.metadata).toMatchObject({ collected: ["worker"], pending: [], timed_out: false })
        expect(out.output).toContain('"worker" is ready with no structured result yet')

        await finish("collect-ready-no-result")
      },
    })
  })

  test("team_collect reports pending members on timeout", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const sleep = spyOn(Bun, "sleep").mockImplementation((async () => undefined) as any)
        const { lead } = await basic("collect-timeout")
        let now = 0
        const time = spyOn(Date, "now").mockImplementation(() => {
          now += 6_000
          return now
        })

        const out = await (
          await TeamCollectTool.init()
        ).execute({ timeout_seconds: 10, poll_interval_seconds: 5 }, ctx(lead.id))

        expect(out.metadata).toMatchObject({ collected: [], pending: ["worker"], timed_out: true })
        expect(out.output).toContain("Pending: worker")

        time.mockRestore()
        sleep.mockRestore()
        await finish("collect-timeout")
      },
    })
  })
})
