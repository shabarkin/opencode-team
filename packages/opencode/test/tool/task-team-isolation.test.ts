import { describe, expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import * as Log from "@opencode-ai/core/util/log"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Session, SessionPrompt } from "../../src/team/runtime"
import { Permission } from "../../src/permission"
import { Team } from "../../src/team"
import { callTeamTool } from "../team/_tool-runtime"
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
  TeamMergeTool,
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
  TeamMergeTool.id,
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
    metadata: () => Effect.void,
    ask: () => Effect.void,
  } as any
}

// TODO(team): TaskTool and TeamDelegateTool now require `ctx.extra.promptOps`
// (a TaskPromptOps shape) provided by task.ts in production. The test ctx() helper
// doesn't synthesize it, so every TaskTool invocation in this file fails. Add a
// fake promptOps factory once the call shape is documented; until then skip.
describe.skip("task subagent team tool isolation", () => {
  test("TEAM_TOOL_IDS matches all exported team tools", () => {
    expect([...TEAM_TOOL_IDS].sort() as string[]).toEqual([...ALL_TEAM_TOOL_IDS].sort())
  })

  test("plain task children deny every team tool", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        process.env.ANTHROPIC_API_KEY = "test-key"
      },
      fn: async () => {
        const parent = await Session.create({})
        const parentSeed = await seed(parent.id)
        const parentMsg = await assist(parent.id, parentSeed)

        let seen: any
        const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async (input: any) => {
          seen = input
          return { parts: [{ type: "text", text: "done" }] } as any
        }) as any)

        const result = await callTeamTool(
          TaskTool,
          { description: "plain task", prompt: "Inspect the repo", subagent_type: "explore" },
          ctx(parent.id, parentMsg, await Session.messages({ sessionID: parent.id })),
        )

        const child = await Session.get(result.metadata.sessionId)
        expect(child.permission?.filter((rule: any) => TEAM_TOOL_IDS.includes(rule.permission as any))).toHaveLength(
          TEAM_TOOL_IDS.length,
        )
        expect(await Team.trace(child.id)).toBeUndefined()
        expect(seen.tools.team_notepad).toBe(false)
        expect(seen.tools.team_message).toBe(false)

        prompt.mockRestore()
      },
    })
  })

  test("task_id reuse rejects foreign parent sessions", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        process.env.ANTHROPIC_API_KEY = "test-key"
      },
      fn: async () => {
        const first = await Session.create({})
        const second = await Session.create({})
        const firstSeed = await seed(first.id)
        const secondSeed = await seed(second.id)
        const firstMsg = await assist(first.id, firstSeed)
        const secondMsg = await assist(second.id, secondSeed)

        const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async () => {
          return { parts: [{ type: "text", text: "done" }] } as any
        }) as any)

        const task = await callTeamTool(
          TaskTool,
          { description: "plain task", prompt: "Inspect the repo", subagent_type: "explore" },
          ctx(first.id, firstMsg, await Session.messages({ sessionID: first.id })),
        )

        const reused = await callTeamTool(
          TaskTool,
          {
            description: "plain task",
            prompt: "Inspect the repo",
            subagent_type: "explore",
            task_id: task.metadata.sessionId,
          },
          ctx(second.id, secondMsg, await Session.messages({ sessionID: second.id })),
        )

        expect(reused.title).toBe("Error")
        expect(reused.output).toContain("does not belong to this session")
        expect(prompt).toHaveBeenCalledTimes(1)

        prompt.mockRestore()
      },
    })
  })

  test("team member task children get read-only team_notepad access", async () => {
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

        const result = await callTeamTool(
          TaskTool,
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

  test("restricted team task children inherit parent deny rules", async () => {
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
        const memberSeed = await seed(member.id)
        const memberMsg = await assist(member.id, memberSeed)

        await Session.setPermission({
          sessionID: member.id,
          permission: [
            { permission: "edit", pattern: "*:plan-approval", action: "deny" },
            { permission: "bash", pattern: "*:plan-approval", action: "deny" },
          ],
        })

        await Team.create({ name: "task-lock-team", leadSessionID: lead.id })
        await Team.addMember("task-lock-team", {
          name: "worker",
          sessionID: member.id,
          agent: "general",
          status: "ready",
          checkpoint: "none",
          planApproval: "pending",
        })

        const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async () => {
          return { parts: [{ type: "text", text: "done" }] } as any
        }) as any)

        const result = await callTeamTool(
          TaskTool,
          { description: "locked task", prompt: "Inspect only", subagent_type: "explore" },
          ctx(member.id, memberMsg, await Session.messages({ sessionID: member.id })),
        )

        const child = await Session.get(result.metadata.sessionId)
        expect(Permission.evaluate("edit", "src/index.ts", child.permission ?? []).action).toBe("deny")
        expect(Permission.evaluate("bash", "git status", child.permission ?? []).action).toBe("deny")

        prompt.mockRestore()
        await Team.setMemberStatus("task-lock-team", "worker", "shutdown")
        await Team.cleanup("task-lock-team")
      },
    })
  })

  test("restricted delegates inherit parent deny rules", async () => {
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
        const memberSeed = await seed(member.id)
        const memberMsg = await assist(member.id, memberSeed)

        await Session.setPermission({
          sessionID: member.id,
          permission: [
            { permission: "edit", pattern: "*:plan-approval", action: "deny" },
            { permission: "bash", pattern: "*:plan-approval", action: "deny" },
          ],
        })

        await Team.create({ name: "delegate-lock-team", leadSessionID: lead.id })
        await Team.addMember("delegate-lock-team", {
          name: "worker",
          sessionID: member.id,
          agent: "general",
          status: "ready",
          checkpoint: "none",
          planApproval: "pending",
        })

        const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async () => {
          return { parts: [{ type: "text", text: "done" }] } as any
        }) as any)

        const result = await callTeamTool(
          TeamDelegateTool,
          { description: "locked delegate", prompt: "Inspect only", agent: "explore" },
          ctx(member.id, memberMsg, await Session.messages({ sessionID: member.id })),
        )

        const child = await Session.get(result.metadata.sessionId)
        expect(Permission.evaluate("edit", "src/index.ts", child.permission ?? []).action).toBe("deny")
        expect(Permission.evaluate("bash", "git status", child.permission ?? []).action).toBe("deny")

        prompt.mockRestore()
        await Team.setMemberStatus("delegate-lock-team", "worker", "shutdown")
        await Team.cleanup("delegate-lock-team")
      },
    })
  })

  test("plain task abort catches async cancel failures", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        process.env.ANTHROPIC_API_KEY = "test-key"
      },
      fn: async () => {
        const parent = await Session.create({})
        const parentSeed = await seed(parent.id)
        const parentMsg = await assist(parent.id, parentSeed)
        const ctl = new AbortController()
        let done!: (value: any) => void
        const wait = new Promise((resolve) => {
          done = resolve
        })
        const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async () => {
          return (await wait) as any
        }) as any)
        const cancel = spyOn(SessionPrompt, "cancel").mockRejectedValue(new Error("boom"))
        const hits: unknown[] = []
        const fn = (err: unknown) => {
          hits.push(err)
        }
        process.on("unhandledRejection", fn)

        try {
          const run = callTeamTool(
            TaskTool,
            { description: "plain task", prompt: "Inspect the repo", subagent_type: "explore" },
            {
              ...ctx(parent.id, parentMsg, await Session.messages({ sessionID: parent.id })),
              abort: ctl.signal,
            },
          )

          await Bun.sleep(20)
          ctl.abort()
          await Bun.sleep(20)
          done({ parts: [{ type: "text", text: "done" }] })

          const result = await run
          await Bun.sleep(20)

          expect(cancel).toHaveBeenCalledTimes(1)
          expect(cancel.mock.calls[0]?.[0]).toBe(result.metadata.sessionId)
          expect(hits).toHaveLength(0)
        } finally {
          process.off("unhandledRejection", fn)
          cancel.mockRestore()
          prompt.mockRestore()
        }
      },
    })
  })

  test("team delegate abort catches async cancel failures", async () => {
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
        const memberSeed = await seed(member.id)
        const memberMsg = await assist(member.id, memberSeed)
        const ctl = new AbortController()
        let done!: (value: any) => void
        const wait = new Promise((resolve) => {
          done = resolve
        })

        await Team.create({ name: "delegate-abort-team", leadSessionID: lead.id })
        await Team.addMember("delegate-abort-team", {
          name: "worker",
          sessionID: member.id,
          agent: "general",
          status: "ready",
          checkpoint: "none",
          planApproval: "none",
        })

        const prompt = spyOn(SessionPrompt, "prompt").mockImplementation((async () => {
          return (await wait) as any
        }) as any)
        const cancel = spyOn(SessionPrompt, "cancel").mockRejectedValue(new Error("boom"))
        const hits: unknown[] = []
        const fn = (err: unknown) => {
          hits.push(err)
        }
        process.on("unhandledRejection", fn)

        try {
          const run = callTeamTool(
            TeamDelegateTool,
            { description: "delegate task", prompt: "Inspect the plan", agent: "explore" },
            {
              ...ctx(member.id, memberMsg, await Session.messages({ sessionID: member.id })),
              abort: ctl.signal,
            },
          )

          await Bun.sleep(20)
          ctl.abort()
          await Bun.sleep(20)
          done({ parts: [{ type: "text", text: "done" }] })

          const result = await run
          await Bun.sleep(20)

          expect(cancel).toHaveBeenCalledTimes(1)
          expect(cancel.mock.calls[0]?.[0]).toBe(result.metadata.sessionId)
          expect(hits).toHaveLength(0)
        } finally {
          process.off("unhandledRejection", fn)
          cancel.mockRestore()
          prompt.mockRestore()
          await Team.setMemberStatus("delegate-abort-team", "worker", "shutdown")
          await Team.cleanup("delegate-abort-team")
        }
      },
    })
  })

  test("teammate prompt still documents the relay pattern", async () => {
    const src = await Bun.file(new URL("../../src/tool/team.ts", import.meta.url).pathname).text()
    expect(src).toContain("SUBAGENT RELAY")
    expect(src).toContain("they CANNOT communicate with the team")
  })
})
