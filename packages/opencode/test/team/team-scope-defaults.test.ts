import { describe, expect, spyOn, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Session, SessionPrompt } from "../../src/team/runtime"
import { Team } from "../../src/team"
import { TeamPolicy } from "../../src/team/policy"
import { DEFAULT_EXCLUDES, TeamScope } from "../../src/team/scope"
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

describe("team scope defaults", () => {
  test("withDefaults appends the built-in excludes once", () => {
    expect(TeamScope.withDefaults({ path_excludes: ["dist/**", ".git/**"] })).toEqual({
      path_excludes: [...DEFAULT_EXCLUDES, "dist/**"],
    })
  })

  test("spawnMember stores the effective scope with default excludes", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        process.env.ANTHROPIC_API_KEY = "test-key"
      },
      fn: async () => {
        const lead = await Session.create({})
        await seed(lead.id)
        await Team.create({ name: "scope-defaults", leadSessionID: lead.id })

        const loop = spyOn(SessionPrompt, "loop").mockResolvedValue(undefined as never)
        await Team.spawnMember({
          teamName: "scope-defaults",
          name: "worker",
          parentSessionID: lead.id,
          agent: { name: "general" },
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
          prompt: "Scoped task",
          planApproval: false,
          checkpoint: "none",
          scope: {
            path_excludes: ["dist/**"],
            path_includes: ["src/**"],
            bash_allowlist: ["bun test *"],
          },
        })

        await Bun.sleep(20)

        const team = await Team.get("scope-defaults")
        expect(team?.members.find((item) => item.name === "worker")?.scope).toEqual({
          path_excludes: [...DEFAULT_EXCLUDES, "dist/**"],
          path_includes: ["src/**"],
          bash_allowlist: ["bun test *"],
        })

        const out = await TeamPolicy.pathAccess({
          teamName: "scope-defaults",
          memberName: "worker",
          filePath: `${tmp.path}/.opencode/state.json`,
          operation: "write",
        })
        expect(out.allow).toBe(false)

        loop.mockRestore()
        await Team.setMemberStatus("scope-defaults", "worker", "shutdown")
        await Team.cleanup("scope-defaults")
      },
    })
  })
})
