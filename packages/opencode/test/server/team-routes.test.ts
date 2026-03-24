import { afterEach, describe, expect, test } from "bun:test"
import { generateSpecs } from "hono-openapi"
import { Server } from "../../src/server/server"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Team } from "../../src/team"
import { TeamRoutes } from "../../src/server/routes/team"
import { Log } from "../../src/util/log"
import type { SessionID } from "../../src/session/schema"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const flag = process.env.OPENCODE_EXPERIMENTAL_AGENT_TEAMS

afterEach(async () => {
  await Instance.disposeAll()
  await resetDatabase()
  if (flag === undefined) delete process.env.OPENCODE_EXPERIMENTAL_AGENT_TEAMS
  if (flag !== undefined) process.env.OPENCODE_EXPERIMENTAL_AGENT_TEAMS = flag
})

describe("team routes", () => {
  test("are omitted from openapi when feature flag is off", async () => {
    delete process.env.OPENCODE_EXPERIMENTAL_AGENT_TEAMS

    const spec = await generateSpecs(Server.createApp({}), {
      documentation: {
        info: {
          title: "opencode",
          version: "1.0.0",
          description: "opencode api",
        },
        openapi: "3.1.1",
      },
    })

    expect(Object.keys(spec.paths ?? {}).some((path) => path.startsWith("/team"))).toBe(false)
  })

  test("get route requires membership and redacts sensitive fields", async () => {
    process.env.OPENCODE_EXPERIMENTAL_AGENT_TEAMS = "1"
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const lead = (await Session.create({})).id
        const member = (await Session.create({ parentID: lead })).id
        await Team.create({ name: "route-team", leadSessionID: lead })
        await Team.addMember("route-team", {
          name: "worker-a",
          sessionID: member,
          agent: "general",
          status: "busy",
          prompt: "secret prompt",
        })

        const app = TeamRoutes()
        const denied = await app.request("/route-team")
        expect(denied.status).toBe(403)

        const ok = await app.request("/route-team", {
          headers: {
            "x-opencode-session": member,
          },
        })

        expect(ok.status).toBe(200)
        const body = await ok.json()
        expect(body.name).toBe("route-team")
        expect(body.members[0].prompt).toBeUndefined()
        expect(body.members[0].sessionID).toBeUndefined()
      },
    })
  })

  test("by-session route requires matching caller and hides prompts", async () => {
    process.env.OPENCODE_EXPERIMENTAL_AGENT_TEAMS = "1"
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const lead = (await Session.create({})).id
        const member = (await Session.create({ parentID: lead })).id
        await Team.create({ name: "session-team", leadSessionID: lead })
        await Team.addMember("session-team", {
          name: "worker-a",
          sessionID: member,
          agent: "general",
          status: "busy",
          prompt: "secret prompt",
        })

        const app = TeamRoutes()
        const denied = await app.request(`/by-session/${member}`, {
          headers: {
            "x-opencode-session": lead,
          },
        })
        expect(denied.status).toBe(403)

        const ok = await app.request(`/by-session/${member}`, {
          headers: {
            "x-opencode-session": member,
          },
        })

        expect(ok.status).toBe(200)
        const body = await ok.json()
        expect(body.team.members[0].prompt).toBeUndefined()
        expect(body.team.members[0].sessionID).toBe(member)
      },
    })
  })

  test("mutating routes require the lead session", async () => {
    process.env.OPENCODE_EXPERIMENTAL_AGENT_TEAMS = "1"
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const lead = (await Session.create({})).id
        const member = (await Session.create({ parentID: lead })).id
        await Team.create({ name: "control-team", leadSessionID: lead })
        await Team.addMember("control-team", {
          name: "worker-a",
          sessionID: member,
          agent: "general",
          status: "busy",
        })

        const app = TeamRoutes()
        const denied = await app.request("/control-team/cancel", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-opencode-session": member,
          },
          body: JSON.stringify({ member: "worker-a" }),
        })
        expect(denied.status).toBe(403)

        const ok = await app.request("/control-team/cancel", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-opencode-session": lead,
          },
          body: JSON.stringify({ member: "worker-a" }),
        })
        expect(ok.status).toBe(200)
      },
    })
  })
})
