import { SessionID } from "@/session/schema"
import {
  MemberNameSchema,
  PendingSpawnRequestPublicSchema,
  TeamInfoPublicSchema,
  TeamInfoSessionSchema,
  TeamNameSchema,
  TeamTaskSchema,
} from "@/team/events"
import { addDelegateRules, removeDelegateRules, Team, TeamTasks } from "@/team"
import { Session, SessionPrompt } from "@/team/runtime"
import { TeamMessaging } from "@/team/messaging"
import { InstanceRef } from "@/effect/instance-ref"
import { context as instanceContext } from "@/project/instance-context"
import { InstanceRuntime } from "@/project/instance-runtime"
import { InstanceStore } from "@/project/instance-store"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Cause, Effect, Option, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import z from "zod"

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
const TeamCancel = z.object({
  member: MemberNameSchema.optional(),
})
const TeamMessageBody = z.object({
  to: z.union([z.literal("lead"), MemberNameSchema]),
  text: z.string().max(10 * 1024),
})

type Info = NonNullable<Awaited<ReturnType<typeof Team.get>>>
type LeadCheck = { error: HttpServerResponse.HttpServerResponse } | { team: Info }

function json(body: unknown, status = 200): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.jsonUnsafe(body, { status }) as HttpServerResponse.HttpServerResponse
}

function unavailable() {
  return json({ error: "Not found" }, 404)
}

function forbidden() {
  return json({ error: "Forbidden" }, 403)
}

function invalid(err: unknown) {
  if (err instanceof Error && err.name === "TeamStateError") return json({ error: err.message }, 409)
  if (err instanceof z.ZodError || err instanceof SyntaxError) return json({ error: "Invalid request" }, 400)
}

function sessionID(raw: string | undefined) {
  if (!raw) return
  try {
    return SessionID.make(raw)
  } catch {
    return
  }
}

function caller(request: HttpServerRequest.HttpServerRequest) {
  return sessionID(request.headers["x-opencode-session"])
}

function requestDirectory(request: HttpServerRequest.HttpServerRequest) {
  const url = new URL(request.url, "http://localhost")
  const directory = url.searchParams.get("directory") || request.headers["x-opencode-directory"] || process.cwd()
  try {
    return decodeURIComponent(directory)
  } catch {
    return directory
  }
}

function requests(team: Info, full: boolean) {
  if (full) return team.pending_spawn_requests
  return (team.pending_spawn_requests ?? []).map((item) => PendingSpawnRequestPublicSchema.parse(item))
}

function members(team: Info, full: boolean) {
  return team.members.map((member) => ({
    name: member.name,
    ...(full ? { sessionID: member.sessionID } : {}),
    agent: member.agent,
    status: member.status,
    execution_status: member.execution_status,
    model: member.model,
    planApproval: member.planApproval,
    checkpoint: member.checkpoint,
  }))
}

function publicTeam(team: Info) {
  return TeamInfoPublicSchema.parse({
    name: team.name,
    created: team.created,
    delegate: team.delegate,
    members: members(team, false),
    pending_spawn_requests: requests(team, false),
  })
}

function sessionTeam(team: Info) {
  return TeamInfoSessionSchema.parse({
    name: team.name,
    created: team.created,
    delegate: team.delegate,
    members: members(team, true),
    pending_spawn_requests: requests(team, true),
  })
}

const body = <T>(schema: z.ZodType<T>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const text = yield* Effect.orDie(request.text)
    return yield* Effect.try({
      try: () => schema.parse(JSON.parse(text || "{}")),
      catch: (err) => err,
    })
  })

const legacy = <A>(fn: () => Promise<A>) =>
  Effect.gen(function* () {
    const ctx = yield* InstanceRef
    const request = yield* HttpServerRequest.HttpServerRequest
    const directory = requestDirectory(request)
    const fallback = yield* Effect.sync(() => {
      try {
        return instanceContext.use()
      } catch {
        return undefined
      }
    })
    const store = Option.getOrUndefined(yield* Effect.serviceOption(InstanceStore.Service))
    const next =
      ctx ??
      fallback ??
      (store ? yield* store.load({ directory }) : yield* Effect.promise(() => InstanceRuntime.load({ directory })))
    return yield* Effect.tryPromise({
      try: () => instanceContext.provide(next, fn),
      catch: (err) => err,
    })
  })

const TeamNameParam = Schema.Struct({ name: Schema.String })
const SessionParam = Schema.Struct({ sessionID: Schema.String })

const teamNameParam = Effect.map(HttpRouter.schemaPathParams(TeamNameParam), (input) => TeamNameSchema.parse(input.name))
const sessionParam = Effect.map(HttpRouter.schemaPathParams(SessionParam), (input) => SessionID.make(input.sessionID))

function requireLead(request: HttpServerRequest.HttpServerRequest, name: string) {
  return legacy(async (): Promise<LeadCheck> => {
    const sid = caller(request)
    if (!sid) return { error: forbidden() } as const
    const match = await Team.findBySession(sid)
    if (!match || match.role !== "lead" || match.team.name !== name) return { error: forbidden() } as const
    const team = await Team.get(name)
    if (!team) return { error: json({ error: "Team not found" }, 404) } as const
    return { team }
  })
}

function requireTeammate(team: Info, name: string): HttpServerResponse.HttpServerResponse | undefined {
  if (!team.members.some((item) => item.name === name)) return json({ error: "Teammate not found" }, 404)
}

const route = <E, R>(effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.gen(function* () {
    if (!Flag.OPENCODE_EXPERIMENTAL_AGENT_TEAMS) return unavailable()
    return yield* effect.pipe(
      Effect.catchCause((cause) => {
        const response = invalid(Cause.squash(cause))
        if (response) return Effect.succeed(response)
        return Effect.failCause(cause)
      }),
    )
  })

export const teamRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add(
      "GET",
      "/team",
      route(
        Effect.gen(function* () {
          const sid = caller(yield* HttpServerRequest.HttpServerRequest)
          if (!sid) return forbidden()
          const match = yield* legacy(() => Team.findBySession(sid))
          if (!match) return json([])
          return json([publicTeam(match.team)])
        }),
      ),
    )

    yield* router.add(
      "GET",
      "/team/by-session/:sessionID",
      route(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const sid = yield* sessionParam
          if (caller(request) !== sid) return forbidden()
          const result = yield* legacy(() => Team.findBySession(sid))
          if (!result) return json(null)
          const tasks = yield* legacy(() => TeamTasks.list(result.team.name))
          if (result.role === "lead") {
            return json({
              team: sessionTeam(result.team),
              tasks: TeamTaskSchema.array().parse(tasks),
              leadSessionID: SessionID.make(result.team.leadSessionID),
              role: "lead" as const,
            })
          }
          return json({
            team: publicTeam(result.team),
            tasks: TeamTaskSchema.array().parse(tasks),
            leadSessionID: SessionID.make(result.team.leadSessionID),
            role: "member" as const,
            memberName: result.memberName,
          })
        }),
      ),
    )

    yield* router.add(
      "GET",
      "/team/:name/tasks",
      route(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const name = yield* teamNameParam
          const sid = caller(request)
          if (!sid) return forbidden()
          const match = yield* legacy(() => Team.findBySession(sid))
          if (!match || match.team.name !== name) return forbidden()
          return json(TeamTaskSchema.array().parse(yield* legacy(() => TeamTasks.list(name))))
        }),
      ),
    )

    yield* router.add(
      "GET",
      "/team/:name",
      route(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const name = yield* teamNameParam
          const sid = caller(request)
          if (!sid) return forbidden()
          const match = yield* legacy(() => Team.findBySession(sid))
          if (!match || match.team.name !== name) return forbidden()
          return json(publicTeam(match.team))
        }),
      ),
    )

    yield* router.add(
      "POST",
      "/team/:name/delegate",
      route(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const name = yield* teamNameParam
          const input = yield* body(Delegate)
          const info = yield* requireLead(request, name)
          if ("error" in info) return info.error
          const sid = SessionID.make(info.team.leadSessionID)
          const session = yield* legacy(() => Session.get(sid))
          yield* legacy(() =>
            Session.setPermission({
              sessionID: sid,
              permission: input.enabled
                ? addDelegateRules(session.permission ?? [])
                : removeDelegateRules(session.permission ?? []),
            }),
          )
          yield* legacy(() => Team.setDelegate(name, input.enabled))
          return json({ ok: true, delegate: input.enabled })
        }),
      ),
    )

    yield* router.add(
      "POST",
      "/team/:name/steer",
      route(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const name = yield* teamNameParam
          const input = yield* body(TeamSteer)
          const info = yield* requireLead(request, name)
          if ("error" in info) return info.error
          const missing = requireTeammate(info.team, input.member)
          if (missing) return missing
          const action = yield* legacy(() =>
            Team.steer({ teamName: name, memberName: input.member, text: input.text }),
          )
          return json({ ok: true as const, action })
        }),
      ),
    )

    yield* router.add(
      "POST",
      "/team/:name/pause",
      route(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const name = yield* teamNameParam
          const input = yield* body(TeamPause)
          const info = yield* requireLead(request, name)
          if ("error" in info) return info.error
          const missing = requireTeammate(info.team, input.member)
          if (missing) return missing
          yield* legacy(() => Team.pause({ teamName: name, memberName: input.member }))
          return json({ ok: true as const })
        }),
      ),
    )

    yield* router.add(
      "POST",
      "/team/:name/resume",
      route(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const name = yield* teamNameParam
          const input = yield* body(TeamResume)
          const info = yield* requireLead(request, name)
          if ("error" in info) return info.error
          const missing = requireTeammate(info.team, input.member)
          if (missing) return missing
          yield* legacy(() =>
            Team.resume({ teamName: name, memberName: input.member, redirect: input.redirect }),
          )
          return json({ ok: true as const })
        }),
      ),
    )

    yield* router.add(
      "POST",
      "/team/:name/steer-all",
      route(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const name = yield* teamNameParam
          const input = yield* body(TeamSteerAll)
          const info = yield* requireLead(request, name)
          if ("error" in info) return info.error
          const result = yield* legacy(() => Team.steerAll({ teamName: name, text: input.text }))
          if (result.errors.length > 0) {
            return json(
              {
                error: `Failed to steer ${result.errors.length} teammate(s).`,
                targets: result.targets,
                delivered: result.delivered,
                errors: result.errors,
              },
              409,
            )
          }
          return json({ ok: true as const, ...result })
        }),
      ),
    )

    yield* router.add(
      "POST",
      "/team/:name/cancel",
      route(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const name = yield* teamNameParam
          const input = yield* body(TeamCancel)
          const info = yield* requireLead(request, name)
          if ("error" in info) return info.error
          if (input.member) {
            const ok = yield* legacy(() => Team.cancelMember(name, input.member!))
            return json({ ok, cancelled: ok ? 1 : 0 })
          }
          const cancelled = yield* legacy(() => Team.cancelAllMembers(name))
          return json({ ok: true, cancelled })
        }),
      ),
    )

    yield* router.add(
      "POST",
      "/session/:sessionID/steer",
      route(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const sid = yield* sessionParam
          if (caller(request) !== sid) return forbidden()
          const input = yield* body(z.object({ text: z.string() }))
          yield* legacy(() => SessionPrompt.steer(sid, input.text))
          return json(true)
        }),
      ),
    )

    yield* router.add(
      "POST",
      "/session/:sessionID/team-message",
      route(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const sid = yield* sessionParam
          if (caller(request) !== sid) return forbidden()
          const input = yield* body(TeamMessageBody)
          const match = yield* legacy(() => Team.findBySession(sid))
          if (!match) return forbidden()
          const from = match.role === "lead" ? "lead" : match.memberName
          if (!from) return forbidden()
          yield* legacy(() =>
            TeamMessaging.send({
              teamName: match.team.name,
              from,
              to: input.to,
              text: input.text,
            }),
          )
          return json(true)
        }),
      ),
    )
  }),
)
