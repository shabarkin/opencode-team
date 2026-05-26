import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Server } from "../../src/server/server"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/team/runtime"
import { Team } from "../../src/team"
import { TeamRoutes } from "../../src/server/routes/instance/team"
import * as Log from "@opencode-ai/core/util/log"
import type { SessionID } from "../../src/session/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const flag = process.env.OPENCODE_EXPERIMENTAL_AGENT_TEAMS

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
  if (flag === undefined) delete process.env.OPENCODE_EXPERIMENTAL_AGENT_TEAMS
  if (flag !== undefined) process.env.OPENCODE_EXPERIMENTAL_AGENT_TEAMS = flag
})

describe("team routes", () => {
  test("are omitted from openapi when feature flag is off", async () => {
    delete process.env.OPENCODE_EXPERIMENTAL_AGENT_TEAMS

    const spec = await Server.openapi()

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
        await Team.requestSpawn({
          teamName: "route-team",
          requestedBy: "worker-a",
          agent: "explore",
          rationale: "check secret area",
          prompt: "inspect hidden files",
          messages: [],
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
        expect(body.pending_spawn_requests[0].rationale).toBeUndefined()
        expect(body.pending_spawn_requests[0].prompt).toBeUndefined()
      },
    })
  })

  test("request object and URL inputs preserve legacy team route prefix", async () => {
    process.env.OPENCODE_EXPERIMENTAL_AGENT_TEAMS = "1"
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const lead = (await Session.create({})).id
        await Team.create({ name: "request-team", leadSessionID: lead })

        const res = await TeamRoutes().request(
          new Request("http://localhost/request-team", {
            headers: {
              "x-opencode-session": lead,
            },
          }),
        )

        expect(res.status).toBe(200)
        expect((await res.json()).name).toBe("request-team")

        const url = await TeamRoutes().request(new URL("http://localhost/request-team"), {
          headers: {
            "x-opencode-session": lead,
          },
        })

        expect(url.status).toBe(200)
        expect((await url.json()).name).toBe("request-team")

        const urlString = await TeamRoutes().request("http://localhost/request-team", {
          headers: {
            "x-opencode-session": lead,
          },
        })

        expect(urlString.status).toBe(200)
        expect((await urlString.json()).name).toBe("request-team")
      },
    })
  })

  test("by-session route requires matching caller and redacts teammate session ids for members", async () => {
    process.env.OPENCODE_EXPERIMENTAL_AGENT_TEAMS = "1"
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const lead = (await Session.create({})).id
        const member = (await Session.create({ parentID: lead })).id
        const peer = (await Session.create({ parentID: lead })).id
        await Team.create({ name: "session-team", leadSessionID: lead })
        await Team.addMember("session-team", {
          name: "worker-a",
          sessionID: member,
          agent: "general",
          status: "busy",
          prompt: "secret prompt",
        })
        await Team.addMember("session-team", {
          name: "worker-b",
          sessionID: peer,
          agent: "general",
          status: "ready",
          prompt: "peer secret",
        })
        await Team.requestSpawn({
          teamName: "session-team",
          requestedBy: "worker-a",
          agent: "explore",
          rationale: "check secret area",
          prompt: "inspect hidden files",
          messages: [],
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
        expect(body.leadSessionID).toBe(lead)
        expect(body.role).toBe("member")
        expect(body.team.members[0].prompt).toBeUndefined()
        expect(body.team.members[0].sessionID).toBeUndefined()
        expect(body.team.members[1].sessionID).toBeUndefined()
        expect(body.team.pending_spawn_requests[0].rationale).toBeUndefined()
        expect(body.team.pending_spawn_requests[0].prompt).toBeUndefined()

        const leadView = await app.request(`/by-session/${lead}`, {
          headers: {
            "x-opencode-session": lead,
          },
        })

        expect(leadView.status).toBe(200)
        const leadBody = await leadView.json()
        expect(leadBody.leadSessionID).toBe(lead)
        expect(leadBody.role).toBe("lead")
        expect(leadBody.team.members[0].sessionID).toBe(member)
        expect(leadBody.team.members[1].sessionID).toBe(peer)
        expect(leadBody.team.pending_spawn_requests[0].rationale).toBe("check secret area")
        expect(leadBody.team.pending_spawn_requests[0].prompt).toBe("inspect hidden files")
      },
    })
  })

  test("raw server team routes restore instance context from directory header", async () => {
    process.env.OPENCODE_EXPERIMENTAL_AGENT_TEAMS = "1"
    await using tmp = await tmpdir()

    const ids = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const lead = (await Session.create({})).id
        await Team.create({ name: "raw-server-team", leadSessionID: lead })
        return { lead }
      },
    })

    const res = await Server.Default().app.request(`/team/by-session/${ids.lead}`, {
      headers: {
        "x-opencode-directory": tmp.path,
        "x-opencode-session": ids.lead,
      },
    })

    expect(res.status).toBe(200)
    expect((await res.json()).team.name).toBe("raw-server-team")
  })

  test("steer route rejects non-leads and accepts the lead", async () => {
    process.env.OPENCODE_EXPERIMENTAL_AGENT_TEAMS = "1"
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const lead = (await Session.create({})).id
        const member = (await Session.create({ parentID: lead })).id
        await Team.create({ name: "steer-team", leadSessionID: lead })
        await Team.addMember("steer-team", {
          name: "worker-a",
          sessionID: member,
          agent: "general",
          status: "ready",
        })

        const steer = spyOn(Team, "steer").mockResolvedValue("restart")
        const app = TeamRoutes()
        const denied = await app.request("/steer-team/steer", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-opencode-session": member,
          },
          body: JSON.stringify({ member: "worker-a", text: "retry this" }),
        })
        expect(denied.status).toBe(403)
        expect(steer).not.toHaveBeenCalled()

        const ok = await app.request("/steer-team/steer", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-opencode-session": lead,
          },
          body: JSON.stringify({ member: "worker-a", text: "retry this" }),
        })
        expect(ok.status).toBe(200)
        expect(await ok.json()).toEqual({ ok: true, action: "restart" })
        expect(steer).toHaveBeenCalledWith({
          teamName: "steer-team",
          memberName: "worker-a",
          text: "retry this",
        })

        steer.mockRestore()
      },
    })
  })

  test("steer route returns conflict for invalid member state", async () => {
    process.env.OPENCODE_EXPERIMENTAL_AGENT_TEAMS = "1"
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const lead = (await Session.create({})).id
        const member = (await Session.create({ parentID: lead })).id
        await Team.create({ name: "steer-conflict", leadSessionID: lead })
        await Team.addMember("steer-conflict", {
          name: "worker-a",
          sessionID: member,
          agent: "general",
          status: "shutdown",
        })

        const app = TeamRoutes()
        const res = await app.request("/steer-conflict/steer", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-opencode-session": lead,
          },
          body: JSON.stringify({ member: "worker-a", text: "retry this" }),
        })

        expect(res.status).toBe(409)
        expect(await res.json()).toEqual({ error: 'Teammate "worker-a" cannot be steered from status shutdown.' })
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

  test("pause, resume, and steer-all routes are lead-only", async () => {
    process.env.OPENCODE_EXPERIMENTAL_AGENT_TEAMS = "1"
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const lead = (await Session.create({})).id
        const member = (await Session.create({ parentID: lead })).id
        await Team.create({ name: "pause-team", leadSessionID: lead })
        await Team.addMember("pause-team", {
          name: "worker-a",
          sessionID: member,
          agent: "general",
          status: "ready",
          checkpoint: "none",
          planApproval: "none",
        })

        const pause = spyOn(Team, "pause").mockResolvedValue(undefined)
        const resume = spyOn(Team, "resume").mockResolvedValue(undefined)
        const steerAll = spyOn(Team, "steerAll").mockResolvedValue({ targets: 1, delivered: 1, errors: [] })
        const app = TeamRoutes()

        const denied = await app.request("/pause-team/pause", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-opencode-session": member,
          },
          body: JSON.stringify({ member: "worker-a" }),
        })
        expect(denied.status).toBe(403)

        const paused = await app.request("/pause-team/pause", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-opencode-session": lead,
          },
          body: JSON.stringify({ member: "worker-a" }),
        })
        expect(paused.status).toBe(200)
        expect(pause).toHaveBeenCalledWith({ teamName: "pause-team", memberName: "worker-a" })

        const resumed = await app.request("/pause-team/resume", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-opencode-session": lead,
          },
          body: JSON.stringify({ member: "worker-a", redirect: "continue" }),
        })
        expect(resumed.status).toBe(200)
        expect(resume).toHaveBeenCalledWith({ teamName: "pause-team", memberName: "worker-a", redirect: "continue" })

        const broadcast = await app.request("/pause-team/steer-all", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-opencode-session": lead,
          },
          body: JSON.stringify({ text: "regroup" }),
        })
        expect(broadcast.status).toBe(200)
        expect(await broadcast.json()).toEqual({ ok: true, targets: 1, delivered: 1, errors: [] })
        expect(steerAll).toHaveBeenCalledWith({ teamName: "pause-team", text: "regroup" })

        pause.mockRestore()
        resume.mockRestore()
        steerAll.mockRestore()
      },
    })
  })

  test("steer-all surfaces partial delivery failures", async () => {
    process.env.OPENCODE_EXPERIMENTAL_AGENT_TEAMS = "1"
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const lead = (await Session.create({})).id
        await Team.create({ name: "broadcast-team", leadSessionID: lead })

        const steerAll = spyOn(Team, "steerAll").mockResolvedValue({
          targets: 2,
          delivered: 1,
          errors: [{ target: "worker-a", error: "delivery failed" }],
        })

        const app = TeamRoutes()
        const res = await app.request("/broadcast-team/steer-all", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-opencode-session": lead,
          },
          body: JSON.stringify({ text: "regroup" }),
        })

        expect(res.status).toBe(409)
        expect(await res.json()).toEqual({
          error: "Failed to steer 1 teammate(s).",
          targets: 2,
          delivered: 1,
          errors: [{ target: "worker-a", error: "delivery failed" }],
        })

        steerAll.mockRestore()
      },
    })
  })
})
