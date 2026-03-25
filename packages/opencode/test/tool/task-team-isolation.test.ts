import { describe, expect, spyOn, test } from "bun:test"
import { Env } from "../../src/env"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Team } from "../../src/team"
import { TEAM_TOOL_IDS } from "../../src/tool/team"
import { TeamCollectTool } from "../../src/tool/team-collect"
import {
  TeamApprovePlanTool,
  TeamBroadcastTool,
  TeamClaimTool,
  TeamCleanupTool,
  TeamCreateTool,
  TeamHealthTool,
  TeamMessageTool,
  TeamReplyTool,
  TeamRequestSpawnTool,
  TeamRestartTool,
  TeamShutdownTool,
  TeamSpawnTool,
  TeamTasksTool,
} from "../../src/tool/team"
import { TeamInboxTool, TeamSubmitResultTool, TeamWaitTool } from "../../src/tool/team-inbox"
import { TeamPhaseTool, TeamShutdownAllTool } from "../../src/tool/team-lifecycle"
import { TeamDelegateTool } from "../../src/tool/team-delegate"
import { TeamNotepadTool } from "../../src/tool/team-notepad"
import { TeamStatusTool } from "../../src/tool/team-status"
import { TaskTool } from "../../src/tool/task"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const ALL_TEAM_TOOL_IDS = [
  TeamCreateTool.id,
  TeamSpawnTool.id,
  TeamRequestSpawnTool.id,
  TeamMessageTool.id,
  TeamReplyTool.id,
  TeamBroadcastTool.id,
  TeamDelegateTool.id,
  TeamInboxTool.id,
  TeamSubmitResultTool.id,
  TeamWaitTool.id,
  TeamCollectTool.id,
  TeamTasksTool.id,
  TeamClaimTool.id,
  TeamApprovePlanTool.id,
  TeamShutdownAllTool.id,
  TeamShutdownTool.id,
  TeamCleanupTool.id,
  TeamPhaseTool.id,
  TeamStatusTool.id,
  TeamNotepadTool.id,
  TeamHealthTool.id,
  TeamRestartTool.id,
]

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

function ctx(sessionID: string, messageID = MessageID.ascending(), messages: any[] = []) {
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

describe("task subagent team tool isolation", () => {
  test("TEAM_TOOL_IDS matches all exported team tools", () => {
    expect([...TEAM_TOOL_IDS].sort() as string[]).toEqual([...ALL_TEAM_TOOL_IDS].sort())
  })

  test("plain task children deny every team tool", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => Env.set("ANTHROPIC_API_KEY", "test-key"),
      fn: async () => {
        const parent = await Session.create({})
        const parentSeed = await seed(parent.id)
        const parentMsg = await assist(parent.id, parentSeed)

        let seen: any
        const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (input: any) => {
          seen = input
          return { parts: [{ type: "text", text: "done" }] } as any
        }) as any)

        const tool = await TaskTool.init()
        const result = await tool.execute(
          { description: "plain task", prompt: "Inspect the repo", subagent_type: "explore" },
          ctx(parent.id, parentMsg, await Session.messages({ sessionID: parent.id })),
        )

        const child = await Session.get(result.metadata.sessionId)
        expect(child.permission?.filter((rule) => TEAM_TOOL_IDS.includes(rule.permission as any))).toHaveLength(
          TEAM_TOOL_IDS.length,
        )
        expect(await Team.trace(child.id)).toBeUndefined()
        expect(seen.tools.team_notepad).toBe(false)
        expect(seen.tools.team_message).toBe(false)

        prompt.mockRestore()
      },
    })
  })

  test("team member task children get read-only team_notepad access", async () => {
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

        await Team.create({ name: "task-team", leadSessionID: lead.id })
        await Team.addMember("task-team", {
          name: "worker",
          sessionID: member.id,
          agent: "general",
          status: "ready",
          checkpoint: "none",
          planApproval: "none",
        })

        let seen: any
        const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (input: any) => {
          seen = input
          return { parts: [{ type: "text", text: "done" }] } as any
        }) as any)

        const tool = await TaskTool.init()
        const result = await tool.execute(
          { description: "team task", prompt: "Check the shared plan", subagent_type: "explore" },
          ctx(member.id, memberMsg, await Session.messages({ sessionID: member.id })),
        )

        const child = await Session.get(result.metadata.sessionId)
        expect(child.title).toContain("task-team/worker")
        expect(await Team.trace(child.id)).toEqual({
          parentTeam: "task-team",
          parentMember: "worker",
          mode: "task",
        })
        expect(child.permission).toContainEqual({ permission: "team_notepad", pattern: "read", action: "allow" })
        expect(child.permission).toContainEqual({ permission: "team_notepad", pattern: "list", action: "allow" })
        expect(child.permission).toContainEqual({ permission: "team_notepad", pattern: "write", action: "deny" })
        expect(child.permission).toContainEqual({ permission: "team_notepad", pattern: "delete", action: "deny" })
        expect(seen.tools.team_message).toBe(false)
        expect(seen.tools.team_notepad).toBeUndefined()

        prompt.mockRestore()
        await Team.setMemberStatus("task-team", "worker", "shutdown")
        await Team.cleanup("task-team")
      },
    })
  })

  test("teammate prompt still documents the relay pattern", async () => {
    const src = await Bun.file(new URL("../../src/tool/team.ts", import.meta.url).pathname).text()
    expect(src).toContain("SUBAGENT RELAY")
    expect(src).toContain("they CANNOT communicate with the team")
  })
})
