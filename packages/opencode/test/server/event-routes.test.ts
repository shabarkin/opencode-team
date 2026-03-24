import { describe, expect, test } from "bun:test"
import { redact } from "../../src/server/routes/event"

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
})
