import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { childSession, teamTool } from "../../src/cli/cmd/tool-link"

function tool(tool: string, input: Record<string, unknown>, metadata: Record<string, unknown> = {}): ToolPart {
  return {
    id: `part_${tool}`,
    sessionID: "ses_root",
    messageID: "msg_root",
    type: "tool",
    callID: `call_${tool}`,
    tool,
    state: {
      status: "completed",
      input,
      output: "",
      title: "",
      metadata,
      time: { start: 0, end: 1 },
    },
  }
}

describe("tool-link", () => {
  test("returns child sessions for task and team child tools", () => {
    expect(childSession(tool("task", { description: "scan" }, { sessionId: "ses_task" }))).toBe("ses_task")
    expect(childSession(tool("team_spawn", { name: "scout" }, { sessionId: "ses_spawn" }))).toBe("ses_spawn")
    expect(childSession(tool("team_delegate", { description: "scan" }, { sessionId: "ses_delegate" }))).toBe(
      "ses_delegate",
    )
    expect(childSession(tool("team_request_spawn", { name: "scout" }, { sessionId: "ses_req", approved: true }))).toBe(
      "ses_req",
    )
    expect(
      childSession(tool("team_request_spawn", { name: "scout" }, { sessionId: "ses_req", approved: false })),
    ).toBeUndefined()
  })

  test("returns inline info for team tools", () => {
    expect(
      teamTool(tool("team_spawn", { name: "scout", prompt: "Review schema" }, { sessionId: "ses_spawn" })),
    ).toEqual({
      icon: "│",
      pending: "Spawning teammate...",
      title: "Teammate: scout",
      subtitle: "Review schema",
    })

    expect(
      teamTool(tool("team_request_spawn", { agent: "explore" }, { sessionId: "ses_req", approved: true })),
    ).toEqual({
      icon: "│",
      pending: "Spawning teammate...",
      title: "Teammate: explore",
      subtitle: undefined,
    })

    expect(teamTool(tool("team_delegate", { description: "Summarize diff" }, { sessionId: "ses_delegate" }))).toEqual({
      icon: "│",
      pending: "Delegating...",
      title: "Delegate",
      subtitle: "Summarize diff",
    })

    expect(teamTool(tool("team_create", { name: "alpha" }))).toEqual({
      icon: "⑂",
      pending: "Creating team...",
      title: "Created team: alpha",
    })
  })
})
