import { describe, expect, test } from "bun:test"
import { redact } from "../../src/server/routes/instance/event"

describe("event route redaction", () => {
  test("redacts sensitive team event fields", () => {
    const event = redact({
      type: "team.message",
      properties: {
        teamName: "alpha",
        from: "lead",
        to: "worker",
        text: "secret",
      },
    })

    expect(event).toEqual({
      type: "team.message",
      properties: {
        teamName: "alpha",
        from: "lead",
        to: "worker",
      },
    })
  })

  test("redacts spawned member prompt and session details", () => {
    const event = redact({
      type: "team.member.spawned",
      properties: {
        teamName: "alpha",
        member: {
          name: "worker",
          agent: "general",
          status: "busy",
          sessionID: "ses_secret",
          prompt: "secret prompt",
        },
      },
    })

    expect(event).toEqual({
      type: "team.member.spawned",
      properties: {
        teamName: "alpha",
        memberName: "worker",
        agent: "general",
        status: "busy",
      },
    })
  })

  test("redacts submitted results and shutdown lead session ids", () => {
    const result = redact({
      type: "team.result.submitted",
      properties: {
        teamName: "alpha",
        memberName: "worker",
        taskId: "task_1",
        result: {
          title: "Done",
          summary: "secret summary",
          status: "success",
          evidence: "secret evidence",
        },
      },
    })

    expect(result).toEqual({
      type: "team.result.submitted",
      properties: {
        teamName: "alpha",
        memberName: "worker",
        title: "Done",
        status: "success",
        taskId: "task_1",
      },
    })

    const shutdown = redact({
      type: "team.all-members-shutdown",
      properties: {
        teamName: "alpha",
        leadSessionID: "ses_secret",
        grace: 1000,
        cleanupAt: 2000,
      },
    })

    expect(shutdown).toEqual({
      type: "team.all-members-shutdown",
      properties: {
        teamName: "alpha",
        grace: 1000,
        cleanupAt: 2000,
      },
    })
  })
})
