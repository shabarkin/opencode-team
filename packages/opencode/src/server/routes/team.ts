import { Hono, type Context } from "hono"
import z from "zod"
import { describeRoute, validator, resolver } from "hono-openapi"
import {
  Team,
  TeamTasks,
  TeamNameSchema,
  MemberNameSchema,
  TeamInfoPublicSchema,
  TeamInfoSessionSchema,
  TeamTaskSchema,
  addDelegateRules,
  removeDelegateRules,
} from "@/team"
import { Session } from "@/session"
import { SessionID } from "@/session/schema"
import { lazy } from "../../util/lazy"
import { errors } from "../error"

const Delegate = z.object({ enabled: z.boolean() })
const TeamSteer = z.object({
  member: MemberNameSchema,
  text: z.string(),
})
const TeamPause = z.object({
  member: MemberNameSchema,
})
const TeamResume = z.object({
  member: MemberNameSchema,
  redirect: z.string().optional(),
})
const TeamSteerAll = z.object({
  text: z.string(),
})

const LeadTeamSessionResponse = z.object({
  team: TeamInfoSessionSchema,
  tasks: z.array(TeamTaskSchema),
  leadSessionID: SessionID.zod,
  role: z.literal("lead"),
})

const MemberTeamSessionResponse = z.object({
  team: TeamInfoPublicSchema,
  tasks: z.array(TeamTaskSchema),
  role: z.literal("member"),
  memberName: MemberNameSchema.optional(),
})

const TeamSessionResponse = z.union([LeadTeamSessionResponse, MemberTeamSessionResponse])

type Info = NonNullable<Awaited<ReturnType<typeof Team.get>>>

function caller(c: Context) {
  const raw = c.req.header("x-opencode-session")
  if (!raw) return
  const result = SessionID.zod.safeParse(raw)
  if (!result.success) return
  return result.data
}

function publicTeam(team: Info) {
  return {
    name: team.name,
    created: team.created,
    delegate: team.delegate,
    members: team.members.map((member) => ({
      name: member.name,
      agent: member.agent,
      status: member.status,
      execution_status: member.execution_status,
      model: member.model,
      planApproval: member.planApproval,
      checkpoint: member.checkpoint,
    })),
    pending_spawn_requests: team.pending_spawn_requests,
  }
}

function sessionTeam(team: Info) {
  return {
    name: team.name,
    created: team.created,
    delegate: team.delegate,
    members: team.members.map((member) => ({
      name: member.name,
      sessionID: member.sessionID,
      agent: member.agent,
      status: member.status,
      execution_status: member.execution_status,
      model: member.model,
      planApproval: member.planApproval,
      checkpoint: member.checkpoint,
    })),
    pending_spawn_requests: team.pending_spawn_requests,
  }
}

function memberTeam(team: Info) {
  return publicTeam(team)
}

async function lead(c: Context, name: string): Promise<{ team: Info } | { error: Response }> {
  const sid = caller(c)
  if (!sid) return { error: c.json({ error: "Forbidden" }, 403) }

  const match = await Team.findBySession(sid)
  if (!match || match.role !== "lead" || match.team.name !== name) {
    return { error: c.json({ error: "Forbidden" }, 403) }
  }

  const team = await Team.get(name)
  if (!team) return { error: c.json({ error: "Team not found" }, 404) }
  return { team }
}

function teammate(c: Context, team: Info, name: string): { error: Response } | { ok: true } {
  if (!team.members.some((item) => item.name === name)) {
    return { error: c.json({ error: "Teammate not found" }, 404) }
  }
  return { ok: true }
}

function invalid(c: Context, err: unknown) {
  if (!(err instanceof Error) || err.name !== "TeamStateError") throw err
  return c.json({ error: err.message }, 409)
}

export const TeamRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List teams",
        description: "List all teams in this project.",
        operationId: "team.list",
        responses: {
          200: {
            description: "List of teams",
            content: { "application/json": { schema: resolver(TeamInfoPublicSchema.array()) } },
          },
          ...errors(403),
        },
      }),
      async (c) => {
        const sid = caller(c)
        if (!sid) return c.json({ error: "Forbidden" }, 403)
        const team = await Team.findBySession(sid)
        if (!team) return c.json([])
        return c.json([publicTeam(team.team)])
      },
    )
    .get(
      "/:name",
      describeRoute({
        summary: "Get team",
        description: "Retrieve a team by name.",
        operationId: "team.get",
        responses: {
          200: {
            description: "Team info",
            content: { "application/json": { schema: resolver(TeamInfoPublicSchema) } },
          },
          ...errors(403, 404),
        },
      }),
      validator("param", z.object({ name: TeamNameSchema })),
      async (c) => {
        const sid = caller(c)
        if (!sid) return c.json({ error: "Forbidden" }, 403)
        const match = await Team.findBySession(sid)
        if (!match || match.team.name !== c.req.valid("param").name) return c.json({ error: "Forbidden" }, 403)
        return c.json(publicTeam(match.team))
      },
    )
    .get(
      "/:name/tasks",
      describeRoute({
        summary: "List team tasks",
        description: "List all tasks for a team.",
        operationId: "team.tasks.list",
        responses: {
          200: {
            description: "List of tasks",
            content: { "application/json": { schema: resolver(TeamTaskSchema.array()) } },
          },
          ...errors(403),
        },
      }),
      validator("param", z.object({ name: TeamNameSchema })),
      async (c) => {
        const sid = caller(c)
        if (!sid) return c.json({ error: "Forbidden" }, 403)
        const match = await Team.findBySession(sid)
        if (!match || match.team.name !== c.req.valid("param").name) return c.json({ error: "Forbidden" }, 403)
        return c.json(await TeamTasks.list(c.req.valid("param").name))
      },
    )
    .get(
      "/by-session/:sessionID",
      describeRoute({
        summary: "Find team by session",
        description: "Find the team a session belongs to.",
        operationId: "team.bySession",
        responses: {
          200: {
            description: "Team info with role and tasks",
            content: { "application/json": { schema: resolver(TeamSessionResponse.nullable()) } },
          },
          ...errors(403),
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        if (caller(c) !== sessionID) return c.json({ error: "Forbidden" }, 403)
        const result = await Team.findBySession(sessionID)
        if (!result) return c.json(null)
        const tasks = await TeamTasks.list(result.team.name)
        if (result.role === "lead") {
          return c.json({
            team: sessionTeam(result.team),
            tasks,
            leadSessionID: SessionID.make(result.team.leadSessionID),
            role: "lead" as const,
          })
        }
        return c.json({
          team: memberTeam(result.team),
          tasks,
          role: "member" as const,
          memberName: result.memberName,
        })
      },
    )
    .post(
      "/:name/delegate",
      describeRoute({
        summary: "Toggle delegate mode",
        description: "Enable or disable delegate mode for a team.",
        operationId: "team.delegate",
        responses: {
          200: { description: "Delegate mode updated" },
          ...errors(400, 403, 404),
        },
      }),
      validator("param", z.object({ name: TeamNameSchema })),
      validator("json", Delegate),
      async (c) => {
        const sid = caller(c)
        if (!sid) return c.json({ error: "Forbidden" }, 403)
        const { name } = c.req.valid("param")
        const { enabled } = c.req.valid("json")
        const match = await Team.findBySession(sid)
        if (!match || match.role !== "lead" || match.team.name !== name) return c.json({ error: "Forbidden" }, 403)
        const team = await Team.get(name)
        if (!team) return c.json({ error: "Team not found" }, 404)

        const lead = SessionID.make(team.leadSessionID)
        const session = await Session.get(lead)
        const permission = enabled
          ? addDelegateRules(session.permission ?? [])
          : removeDelegateRules(session.permission ?? [])
        await Session.setPermission({ sessionID: lead, permission })

        await Team.setDelegate(name, enabled)
        return c.json({ ok: true, delegate: enabled })
      },
    )
    .post(
      "/:name/steer",
      describeRoute({
        summary: "Steer teammate",
        description: "Send lead instructions to a teammate, restarting them when idle or errored.",
        operationId: "team.steer",
        responses: {
          200: {
            description: "Teammate steered",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.literal(true), action: z.enum(["restart", "resume", "message"]) })),
              },
            },
          },
          ...errors(403, 404),
        },
      }),
      validator("param", z.object({ name: TeamNameSchema })),
      validator("json", TeamSteer),
      async (c) => {
        const { name } = c.req.valid("param")
        const { member, text } = c.req.valid("json")
        const info = await lead(c, name)
        if ("error" in info) return info.error
        const next = teammate(c, info.team, member)
        if ("error" in next) return next.error

        try {
          const action = await Team.steer({
            teamName: name,
            memberName: member,
            text,
          })
          return c.json({ ok: true as const, action })
        } catch (err) {
          return invalid(c, err)
        }
      },
    )
    .post(
      "/:name/pause",
      describeRoute({
        summary: "Pause teammate",
        description: "Pause a teammate without shutting down their session.",
        operationId: "team.pause",
        responses: {
          200: { description: "Teammate paused" },
          ...errors(403, 404),
        },
      }),
      validator("param", z.object({ name: TeamNameSchema })),
      validator("json", TeamPause),
      async (c) => {
        const { name } = c.req.valid("param")
        const { member } = c.req.valid("json")
        const info = await lead(c, name)
        if ("error" in info) return info.error
        const next = teammate(c, info.team, member)
        if ("error" in next) return next.error

        try {
          await Team.pause({ teamName: name, memberName: member })
          return c.json({ ok: true as const })
        } catch (err) {
          return invalid(c, err)
        }
      },
    )
    .post(
      "/:name/resume",
      describeRoute({
        summary: "Resume teammate",
        description: "Resume a paused teammate, optionally with a redirect message.",
        operationId: "team.resume",
        responses: {
          200: { description: "Teammate resumed" },
          ...errors(403, 404),
        },
      }),
      validator("param", z.object({ name: TeamNameSchema })),
      validator("json", TeamResume),
      async (c) => {
        const { name } = c.req.valid("param")
        const { member, redirect } = c.req.valid("json")
        const info = await lead(c, name)
        if ("error" in info) return info.error
        const next = teammate(c, info.team, member)
        if ("error" in next) return next.error

        try {
          await Team.resume({ teamName: name, memberName: member, redirect })
          return c.json({ ok: true as const })
        } catch (err) {
          return invalid(c, err)
        }
      },
    )
    .post(
      "/:name/steer-all",
      describeRoute({
        summary: "Steer all teammates",
        description: "Broadcast new instructions to all active teammates.",
        operationId: "team.steerAll",
        responses: {
          200: {
            description: "Instructions broadcast",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    ok: z.literal(true),
                    targets: z.number().int().nonnegative(),
                    delivered: z.number().int().nonnegative(),
                    errors: z.array(z.object({ target: MemberNameSchema, error: z.string() })),
                  }),
                ),
              },
            },
          },
          ...errors(403, 404),
        },
      }),
      validator("param", z.object({ name: TeamNameSchema })),
      validator("json", TeamSteerAll),
      async (c) => {
        const { name } = c.req.valid("param")
        const { text } = c.req.valid("json")
        const info = await lead(c, name)
        if ("error" in info) return info.error

        const result = await Team.steerAll({ teamName: name, text })
        if (result.errors.length > 0) {
          return c.json(
            {
              error: `Failed to steer ${result.errors.length} teammate(s).`,
              targets: result.targets,
              delivered: result.delivered,
              errors: result.errors,
            },
            409,
          )
        }
        return c.json({ ok: true as const, ...result })
      },
    )
    .post(
      "/:name/cancel",
      describeRoute({
        summary: "Cancel teammates",
        description:
          "Cancel active teammates' prompt loops. " + "Pass { member: name } to cancel one, or omit to cancel all.",
        operationId: "team.cancel",
        responses: {
          200: { description: "Number of cancelled members" },
          ...errors(403, 404),
        },
      }),
      validator("param", z.object({ name: TeamNameSchema })),
      validator("json", z.object({ member: MemberNameSchema.optional() })),
      async (c) => {
        const sid = caller(c)
        if (!sid) return c.json({ error: "Forbidden" }, 403)
        const { name } = c.req.valid("param")
        const { member } = c.req.valid("json")
        const match = await Team.findBySession(sid)
        if (!match || match.role !== "lead" || match.team.name !== name) return c.json({ error: "Forbidden" }, 403)
        const team = await Team.get(name)
        if (!team) return c.json({ error: "Team not found" }, 404)

        if (member) {
          const ok = await Team.cancelMember(name, member)
          return c.json({ ok, cancelled: ok ? 1 : 0 })
        }
        const cancelled = await Team.cancelAllMembers(name)
        return c.json({ ok: true, cancelled })
      },
    ),
)
