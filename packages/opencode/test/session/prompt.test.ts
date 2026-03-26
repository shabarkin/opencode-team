import path from "path"
import { describe, expect, spyOn, test } from "bun:test"
import { fileURLToPath } from "url"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

async function seed(sessionID: SessionID) {
  const msg = MessageID.ascending()
  await Session.updateMessage({
    id: msg,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: {
      providerID: ProviderID.make("test"),
      modelID: ModelID.make("test"),
    },
    system: "keep the existing system prompt",
    tools: { read: true },
    variant: "high",
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
        },
      },
      retryCount: 1,
    },
  } satisfies MessageV2.User)
  await Session.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: msg,
    type: "text",
    text: "original task",
  } satisfies MessageV2.TextPart)
}

describe("session.prompt missing file", () => {
  test("does not fail the prompt when a file part is missing", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const missing = path.join(tmp.path, "does-not-exist.ts")
        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            { type: "text", text: "please review @does-not-exist.ts" },
            {
              type: "file",
              mime: "text/plain",
              url: `file://${missing}`,
              filename: "does-not-exist.ts",
            },
          ],
        })

        if (msg.info.role !== "user") throw new Error("expected user message")

        const hasFailure = msg.parts.some(
          (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
        )
        expect(hasFailure).toBe(true)

        await Session.remove(session.id)
      },
    })
  })

  test("keeps stored part order stable when file resolution is async", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const missing = path.join(tmp.path, "still-missing.ts")
        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            {
              type: "file",
              mime: "text/plain",
              url: `file://${missing}`,
              filename: "still-missing.ts",
            },
            { type: "text", text: "after-file" },
          ],
        })

        if (msg.info.role !== "user") throw new Error("expected user message")

        const stored = await MessageV2.get({
          sessionID: session.id,
          messageID: msg.info.id,
        })
        const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

        expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
        expect(text[1]?.includes("Read tool failed to read")).toBe(true)
        expect(text[2]).toBe("after-file")

        await Session.remove(session.id)
      },
    })
  })
})

describe("session.prompt special characters", () => {
  test("handles filenames with # character", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "file#name.txt"), "special content\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const template = "Read @file#name.txt"
        const parts = await SessionPrompt.resolvePromptParts(template)
        const fileParts = parts.filter((part) => part.type === "file")

        expect(fileParts.length).toBe(1)
        expect(fileParts[0].filename).toBe("file#name.txt")
        expect(fileParts[0].url).toContain("%23")

        const decodedPath = fileURLToPath(fileParts[0].url)
        expect(decodedPath).toBe(path.join(tmp.path, "file#name.txt"))

        const message = await SessionPrompt.prompt({
          sessionID: session.id,
          parts,
          noReply: true,
        })
        const stored = await MessageV2.get({ sessionID: session.id, messageID: message.info.id })
        const textParts = stored.parts.filter((part) => part.type === "text")
        const hasContent = textParts.some((part) => part.text.includes("special content"))
        expect(hasContent).toBe(true)

        await Session.remove(session.id)
      },
    })
  })
})

describe("session.prompt agent variant", () => {
  test("applies agent variant only when using agent model", async () => {
    const prev = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "test-openai-key"

    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          agent: {
            build: {
              model: "openai/gpt-5.2",
              variant: "xhigh",
            },
          },
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})

          const other = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            model: { providerID: ProviderID.make("opencode"), modelID: ModelID.make("kimi-k2.5-free") },
            noReply: true,
            parts: [{ type: "text", text: "hello" }],
          })
          if (other.info.role !== "user") throw new Error("expected user message")
          expect(other.info.variant).toBeUndefined()

          const match = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "hello again" }],
          })
          if (match.info.role !== "user") throw new Error("expected user message")
          expect(match.info.model).toEqual({ providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") })
          expect(match.info.variant).toBe("xhigh")

          const override = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            variant: "high",
            parts: [{ type: "text", text: "hello third" }],
          })
          if (override.info.role !== "user") throw new Error("expected user message")
          expect(override.info.variant).toBe("high")

          await Session.remove(session.id)
        },
      })
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prev
    }
  })
})

describe("session.prompt agent hints", () => {
  test("prefers team tools for explicit team requests with agent mentions", async () => {
    const prev = process.env.OPENCODE_EXPERIMENTAL_AGENT_TEAMS
    process.env.OPENCODE_EXPERIMENTAL_AGENT_TEAMS = "1"

    try {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const msg = await SessionPrompt.prompt({
            sessionID: session.id,
            noReply: true,
            parts: await SessionPrompt.resolvePromptParts(
              "Use an agent team with @general and @explore to review the issue in parallel.",
            ),
          })

          if (msg.info.role !== "user") throw new Error("expected user message")

          const text = msg.parts
            .filter((part) => part.type === "text" && part.synthetic)
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("\n")

          expect(text).toContain("team_create/team_spawn")
          expect(text).not.toContain("call the task tool with subagent")

          await Session.remove(session.id)
        },
      })
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_EXPERIMENTAL_AGENT_TEAMS
      else process.env.OPENCODE_EXPERIMENTAL_AGENT_TEAMS = prev
    }
  })

  test("keeps task hints for non-team agent mentions", async () => {
    const prev = process.env.OPENCODE_EXPERIMENTAL_AGENT_TEAMS
    process.env.OPENCODE_EXPERIMENTAL_AGENT_TEAMS = "1"

    try {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const msg = await SessionPrompt.prompt({
            sessionID: session.id,
            noReply: true,
            parts: await SessionPrompt.resolvePromptParts("Ask @general to summarize the latest errors."),
          })

          if (msg.info.role !== "user") throw new Error("expected user message")

          const text = msg.parts
            .filter((part) => part.type === "text" && part.synthetic)
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("\n")

          expect(text).toContain("call the task tool with subagent: general")
          expect(text).not.toContain("team_create/team_spawn")

          await Session.remove(session.id)
        },
      })
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_EXPERIMENTAL_AGENT_TEAMS
      else process.env.OPENCODE_EXPERIMENTAL_AGENT_TEAMS = prev
    }
  })
})

describe("session.prompt steer", () => {
  test("injects a synthetic user message and preserves prompt context", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const status = spyOn(SessionStatus, "get").mockResolvedValue({ type: "busy" } satisfies SessionStatus.Info)
        const loop = spyOn(SessionPrompt, "loop").mockResolvedValue(undefined as never)

        await seed(session.id)
        await SessionPrompt.steer(session.id, "focus on tests instead")

        const msgs = await Session.messages({ sessionID: session.id })
        const last = msgs.at(-1)

        expect(loop).not.toHaveBeenCalled()
        expect(last?.info.role).toBe("user")
        if (last?.info.role === "user") {
          expect(last.info.agent).toBe("build")
          expect(last.info.model).toEqual({
            providerID: ProviderID.make("test"),
            modelID: ModelID.make("test"),
          })
          expect(last.info.system).toBe("keep the existing system prompt")
          expect(last.info.tools).toEqual({ read: true })
          expect(last.info.variant).toBe("high")
          expect(last.info.format).toEqual({
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
              },
            },
            retryCount: 1,
          })
        }

        const part = last?.parts.find((item) => item.type === "text")
        expect(part?.type).toBe("text")
        if (part?.type === "text") {
          expect(part.synthetic).toBe(true)
          expect(part.text).toBe("focus on tests instead")
        }

        loop.mockRestore()
        status.mockRestore()
        await Session.remove(session.id)
      },
    })
  })

  test("auto-wakes idle sessions after steer", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const status = spyOn(SessionStatus, "get").mockResolvedValue({ type: "idle" } satisfies SessionStatus.Info)
        const loop = spyOn(SessionPrompt, "loop").mockResolvedValue(undefined as never)

        await seed(session.id)
        await SessionPrompt.steer(session.id, "pick up the new priority")

        expect(loop).toHaveBeenCalledTimes(1)
        expect(loop).toHaveBeenCalledWith({ sessionID: session.id })

        loop.mockRestore()
        status.mockRestore()
        await Session.remove(session.id)
      },
    })
  })
})
