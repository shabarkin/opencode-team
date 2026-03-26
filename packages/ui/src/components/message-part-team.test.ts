import { describe, expect, test } from "bun:test"
import { teamLabel, teamSession } from "./message-part-team"

const dict = {
  "ui.tool.team.spawn": "Teammate",
  "ui.tool.team.create": "Create Team",
  "ui.tool.team.create.created": "Created team: {{name}}",
  "ui.tool.team.delegate": "Delegate",
}

function t(key: string, params?: Record<string, string | number | boolean>) {
  const value = dict[key as keyof typeof dict] ?? key
  if (!params) return value
  return value.replace(/{{\s*([^}]+?)\s*}}/g, (_, raw) => String(params[String(raw)] ?? ""))
}

describe("message-part-team", () => {
  test("builds team spawn labels from input and metadata", () => {
    expect(
      teamLabel("team_spawn", { name: "scout", prompt: "Review the schema" }, { memberName: "worker" }, t),
    ).toEqual({
      icon: "task",
      title: "Teammate: scout",
      subtitle: "Review the schema",
    })

    expect(teamLabel("team_spawn", {}, { memberName: "worker" }, t)).toEqual({
      icon: "task",
      title: "Teammate: worker",
    })
  })

  test("builds delegate and create labels", () => {
    expect(teamLabel("team_delegate", { description: "Summarize the diff" }, {}, t)).toEqual({
      icon: "task",
      title: "Delegate",
      subtitle: "Summarize the diff",
    })

    expect(teamLabel("team_create", { name: "alpha" }, {}, t)).toEqual({
      icon: "fork",
      title: "Created team: alpha",
    })
  })

  test("builds approved request labels from spawn metadata", () => {
    expect(
      teamLabel(
        "team_request_spawn",
        { name: "scout", prompt: "Review the schema", agent: "explore" },
        { approved: true, sessionId: "ses_child" },
        t,
      ),
    ).toEqual({
      icon: "task",
      title: "Teammate: scout",
      subtitle: "Review the schema",
    })

    expect(teamLabel("team_request_spawn", { agent: "explore" }, { approved: false, sessionId: "ses_child" }, t)).toBe(
      undefined,
    )
  })

  test("reads only lowercase sessionId metadata", () => {
    expect(teamSession({ sessionId: "ses_child" })).toBe("ses_child")
    expect(teamSession({ sessionID: "ses_child" })).toBeUndefined()
  })
})
