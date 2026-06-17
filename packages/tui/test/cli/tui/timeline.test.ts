import { describe, expect, test } from "bun:test"
import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2"
import { timeline } from "../../../src/routes/session/timeline"

function user(id: string, created: number): UserMessage {
  return {
    id,
    sessionID: "ses_123",
    role: "user",
    agent: "build",
    model: {
      providerID: "anthropic",
      modelID: "claude-sonnet-4-20250514",
    },
    time: { created },
  }
}

function assistant(id: string, created: number, completed?: number): AssistantMessage {
  return {
    id,
    sessionID: "ses_123",
    role: "assistant",
    parentID: "msg_user",
    agent: "build",
    providerID: "anthropic",
    modelID: "claude-sonnet-4-20250514",
    mode: "build",
    path: {
      cwd: "/tmp",
      root: "/tmp",
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: completed ? { created, completed } : { created },
  }
}

describe("tui timeline", () => {
  test("places team messages before a completed assistant response", () => {
    const result = timeline([
      user("msg_user", 1_000),
      assistant("msg_assistant", 1_100, 2_000),
      user("msg_team", 1_500),
    ])

    expect(result.map((msg) => msg.id)).toEqual(["msg_user", "msg_team", "msg_assistant"])
  })

  test("keeps a pending assistant response at the end", () => {
    const result = timeline([user("msg_user", 1_000), assistant("msg_assistant", 1_100), user("msg_team", 1_500)])

    expect(result.map((msg) => msg.id)).toEqual(["msg_user", "msg_team", "msg_assistant"])
  })
})
