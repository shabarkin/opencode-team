import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Team, TeamTasks } from "../team"
import { Inbox } from "../team/inbox"
const NOISE_MIN = 5
const NOISE_AGE = 15 * 60 * 1000
const DONE_TASK = new Set(["completed", "cancelled"])

/** Unified keyword pattern for detecting noise in both system and non-system messages. */
const NOISE_KEYWORDS = /timeout|failed|failure|crash|conflict|noise|undelivered|backlog|blocked|error/i

const MEMBER_PHASE_VALUES = ["researching", "implementing", "testing", "waiting_approval", "reporting", "idle"] as const

function done(
  member: NonNullable<Awaited<ReturnType<typeof Team.get>>>["members"][number],
  tasks: Awaited<ReturnType<typeof TeamTasks.list>>,
  items: Awaited<ReturnType<typeof Inbox.all>>,
) {
  if (member.status === "shutdown_requested") return true
  const mark = member.assigned_at ?? 0
  if (typeof member.last_result_at === "number" && member.last_result_at >= mark) return true
  if (
    items.some(
      (item) =>
        item.from === member.name && (item.type === "result" || !!item.metadata?.result) && item.timestamp >= mark,
    )
  ) {
    return true
  }
  const own = tasks.filter((task) => task.assignee === member.name)
  if (own.length > 0 && own.every((task) => DONE_TASK.has(task.status))) return true
  return items.some(
    (item) => item.from === member.name && item.metadata?.completionStatus === "completed" && item.timestamp >= mark,
  )
}

function noisy(items: Awaited<ReturnType<typeof Inbox.all>>, now: number) {
  const since = now - NOISE_AGE
  return (
    items.filter((item) => {
      if (item.read || item.timestamp < since) return false
      if (item.type === "result" || item.type === "plan") return false
      if (/^DEADLINE (WARNING|EXPIRED):/.test(item.text)) return false
      if (item.from === "system") {
        return NOISE_KEYWORDS.test(item.text)
      }
      if (item.type !== "error") return false
      return NOISE_KEYWORDS.test(item.text)
    }).length >= NOISE_MIN
  )
}

export const ShutdownAllParameters = Schema.Struct({
  reason: Schema.optional(Schema.String),
  force: Schema.optional(Schema.Boolean).annotate({
    description: "Skip graceful drain and force every member into shutdown",
  }),
})

type ShutdownAllMetadata = {
  deferred?: boolean
  active?: string[]
  count?: number
  pending?: number
  blocked?: number
  force?: boolean
  noisy?: boolean
}

export const TeamShutdownAllTool = Tool.define<typeof ShutdownAllParameters, ShutdownAllMetadata, never>(
  "team_shutdown_all",
  Effect.gen(function* () {
    return {
      description: "Request shutdown for every active teammate, or force all teammates directly into shutdown.",
      parameters: ShutdownAllParameters,
      execute: (params: Schema.Schema.Type<typeof ShutdownAllParameters>, ctx: Tool.Context<ShutdownAllMetadata>) =>
        Effect.gen(function* () {
          const info = yield* Effect.promise(() => Team.findBySession(ctx.sessionID))
          if (!info || info.role !== "lead") {
            return { title: "Error", output: "Only the team lead can shut down all teammates.", metadata: {} }
          }

          const team = yield* Effect.promise(() => Team.get(info.team.name))
          const live = team?.members.filter((member) => member.status !== "shutdown") ?? []
          const tasks = yield* Effect.promise(() => TeamTasks.list(info.team.name))
          const mail = yield* Effect.promise(() => Inbox.all(info.team.name, "lead").catch(() => []))
          const wait = live.filter((member) => member.status !== "paused" && !done(member, tasks, mail))
          const storm = noisy(mail, Date.now())

          if (!params.force && wait.length > 0 && !storm) {
            return {
              title: "Shutdown deferred",
              output: [
                `Teammates still active or not yet reported completion: ${wait.map((member) => member.name).join(", ")}.`,
                "Do not rush shutdown while reviews are still underway.",
                "Use team_message or team_broadcast to help teammates compare notes, reach consensus, and help each other finish.",
                "Only shut the team down early when repeated error/noise is overwhelming the channel or everyone has finished reviewing.",
              ].join("\n"),
              metadata: { deferred: true, active: wait.map((member) => member.name) },
            }
          }

          if (params.force) {
            const result = yield* Effect.promise(() => Team.forceShutdownAll(info.team.name, params.reason))
            yield* Effect.promise(() => Team.setTeamPhase(info.team.name, "delivery"))
            return {
              title: "Shutdown requested for all teammates",
              output: [
                `Force shutdown confirmed for ${result.shutdown.length} teammate(s).`,
                result.pending.length > 0
                  ? `Still draining: ${result.pending.join(", ")}. Cleanup must wait until their prompt loops stop.`
                  : "",
                "Use this only when repeated errors/noise are derailing the team or you explicitly need an emergency stop.",
                "After final delivery, call team_cleanup to end team mode and resume normal non-team chat unless the user asks for a team again.",
              ]
                .filter(Boolean)
                .join("\n"),
              metadata: { count: result.shutdown.length, pending: result.pending.length, force: true },
            }
          }

          const blocked: string[] = []
          let count = 0
          for (const member of live) {
            const result = yield* Effect.promise(() =>
              Team.shutdown({
                teamName: info.team.name,
                memberName: member.name,
                reason: params.reason,
              }),
            )
            if (result.status === "requested" || result.status === "already_shutdown") {
              count++
              continue
            }
            if (result.status === "blocked") {
              blocked.push(`${member.name}: ${result.reason ?? "blocked by policy"}`)
            }
          }

          yield* Effect.promise(() => Team.setTeamPhase(info.team.name, "delivery"))

          return {
            title: "Shutdown requested for all teammates",
            output: [
              `Requested shutdown for ${count} teammate(s).`,
              storm
                ? "Repeated error/noise detected in the channel, so shutdown is allowed even with active work."
                : "All teammates appear to be done or ready to wrap up, so shutdown is safe.",
              blocked.length > 0 ? `Blocked: ${blocked.join("; ")}` : "",
              blocked.length > 0 && storm
                ? "Some members refused graceful shutdown despite noisy conditions — consider force=true to complete the shutdown."
                : "",
              "After final delivery, call team_cleanup to end team mode and resume normal non-team chat unless the user asks for a team again.",
            ]
              .filter(Boolean)
              .join("\n"),
            metadata: { count, blocked: blocked.length, force: false, noisy: storm },
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof ShutdownAllParameters, ShutdownAllMetadata>
  }),
)

export const PhaseParameters = Schema.Struct({
  phase: Schema.Literals(MEMBER_PHASE_VALUES),
})

type PhaseMetadata = {
  member?: string
  phase?: string
}

export const TeamPhaseTool = Tool.define<typeof PhaseParameters, PhaseMetadata, never>(
  "team_phase",
  Effect.gen(function* () {
    return {
      description: "Report your current work phase to the team lead.",
      parameters: PhaseParameters,
      execute: (params: Schema.Schema.Type<typeof PhaseParameters>, ctx: Tool.Context<PhaseMetadata>) =>
        Effect.gen(function* () {
          const info = yield* Effect.promise(() => Team.findBySession(ctx.sessionID))
          if (!info || info.role !== "member" || !info.memberName) {
            return { title: "Error", output: "Only teammates can report a work phase.", metadata: {} }
          }

          yield* Effect.promise(() => Team.setMemberPhase(info.team.name, info.memberName!, params.phase))
          return {
            title: `Phase updated: ${params.phase}`,
            output: `Reported phase "${params.phase}" for teammate "${info.memberName}".`,
            metadata: { member: info.memberName, phase: params.phase },
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof PhaseParameters, PhaseMetadata>
  }),
)
