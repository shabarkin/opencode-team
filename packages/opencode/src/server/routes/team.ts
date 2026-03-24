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

const TeamSessionResponse = z.object({
  team: TeamInfoSessionSchema,
  tasks: z.array(TeamTaskSchema),
  leadSessionID: SessionID.zod,
  role: z.enum(["lead", "member"]),
  memberName: MemberNameSchema.optional(),
})

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
    })),
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
    })),
  }
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
        return c.json({
          team: sessionTeam(result.team),
          tasks: await TeamTasks.list(result.team.name),
          leadSessionID: SessionID.make(result.team.leadSessionID),
          role: result.role,
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
                schema: resolver(z.object({ ok: z.literal(true), action: z.enum(["restart", "message"]) })),
              },
            },
          },
          ...errors(403, 404),
        },
      }),
      validator("param", z.object({ name: TeamNameSchema })),
      validator("json", TeamSteer),
      async (c) => {
        const sid = caller(c)
        if (!sid) return c.json({ error: "Forbidden" }, 403)

        const { name } = c.req.valid("param")
        const { member, text } = c.req.valid("json")
        const match = await Team.findBySession(sid)
        if (!match || match.role !== "lead" || match.team.name !== name) return c.json({ error: "Forbidden" }, 403)

        const team = await Team.get(name)
        if (!team) return c.json({ error: "Team not found" }, 404)
        if (!team.members.some((item) => item.name === member)) return c.json({ error: "Teammate not found" }, 404)

        const action = await Team.steer({
          teamName: name,
          memberName: member,
          text,
        })
        return c.json({ ok: true as const, action })
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
