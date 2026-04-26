import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Bus } from "../bus"
import { Inbox } from "../team/inbox"
import { TeamMessaging } from "../team/messaging"
import { Team, TeamEvent, TeamTasks } from "../team"
import { SubmittedResultSchema } from "../team/events"
import { Bounded, SafeName } from "./team-schema"

const RESULT_STATUS_VALUES = ["success", "partial", "blocked", "failed"] as const
const EVIDENCE_TIER_VALUES = ["publicly_evidenced", "strong_analogue", "hypothesis"] as const
const WAIT_FOR_VALUES = ["any_message", "result", "member_idle", "member_shutdown", "all_shutdown"] as const
const INBOX_ACTION_VALUES = ["list", "read", "flush"] as const

function stamp(time: number) {
  return new Date(time).toISOString()
}

function preview(text: string) {
  return text.length > 120 ? text.slice(0, 117) + "..." : text
}

function notice(seconds?: number) {
  return seconds
    ? `Try again in about ${seconds} seconds or use team_status to poll.`
    : "Call team_wait again or use team_status to poll."
}

function inboxTarget(
  info: Awaited<ReturnType<typeof Team.findBySession>>,
  member?: string,
): { name?: string; error?: string } {
  if (!info) return { error: "You are not part of any team." }
  if (info.role === "lead") return { name: member ?? "lead" }
  if (member && member !== info.memberName) {
    return { error: "Only the lead can read another member's inbox." }
  }
  return { name: info.memberName }
}

function memberTarget(
  info: Awaited<ReturnType<typeof Team.findBySession>>,
  member?: string,
): { name?: string; error?: string } {
  if (!info) return { error: "You are not part of any team." }
  if (info.role === "lead") {
    if (!member) return { error: "member is required for this wait condition." }
    return { name: member }
  }
  if (member && member !== info.memberName) {
    return { error: "Only the lead can inspect another member's state." }
  }
  return { name: info.memberName }
}

function filter(
  items: Awaited<ReturnType<typeof Inbox.all>>,
  params: { since?: number; limit?: number; unread_only?: boolean },
) {
  return items
    .filter((item) => (params.unread_only ? !item.read : true))
    .filter((item) => (params.since ? item.timestamp >= params.since : true))
    .toSorted((a, b) => b.timestamp - a.timestamp)
    .slice(0, params.limit ?? 20)
}

export const InboxParameters = Schema.Struct({
  action: Schema.Literals(INBOX_ACTION_VALUES),
  member: Schema.optional(SafeName).annotate({
    description: "Optional teammate inbox to inspect. Lead only.",
  }),
  limit: Schema.optional(Bounded(1, 50)),
  unread_only: Schema.optional(Schema.Boolean),
  since: Schema.optional(Schema.Number),
})

type InboxMetadata = {
  count?: number
  member?: string
}

export const TeamInboxTool = Tool.define<typeof InboxParameters, InboxMetadata, never>(
  "team_inbox",
  Effect.gen(function* () {
    return {
      description:
        "Read a team inbox, inspect unread messages, or flush undelivered inbox messages. " +
        "For leads, this is the main way to gather teammate findings, blockers, and final results without taking over their work directly.",
      parameters: InboxParameters,
      execute: (params: Schema.Schema.Type<typeof InboxParameters>, ctx: Tool.Context<InboxMetadata>) =>
        Effect.gen(function* () {
          const info = yield* Effect.promise(() => Team.findBySession(ctx.sessionID))
          const target = inboxTarget(info, params.member)
          if (!info || target.error || !target.name) {
            return { title: "Error", output: target.error ?? "You are not part of any team.", metadata: {} }
          }

          const teamName = info.team.name
          if (params.action === "flush") {
            const count = yield* Effect.promise(() => TeamMessaging.flush(teamName, target.name!))
            return {
              title: `Inbox flushed: ${target.name}`,
              output:
                count > 0
                  ? `Reinjected ${count} unread message(s) for "${target.name}".`
                  : `No pending messages for "${target.name}".`,
              metadata: { count, member: target.name },
            }
          }

          const all = yield* Effect.promise(() => Inbox.all(teamName, target.name!))
          const rows = filter(all, params)
          if (params.action === "list") {
            if (rows.length === 0) {
              return {
                title: `Inbox: ${target.name}`,
                output: "Inbox is empty.",
                metadata: { count: 0, member: target.name },
              }
            }

            return {
              title: `Inbox: ${target.name}`,
              output: rows
                .map(
                  (item) =>
                    `[${item.id}] from=${item.from} type=${item.type ?? "message"} priority=${item.priority ?? "normal"} read=${item.read ? "yes" : "no"} at=${stamp(item.timestamp)} ${preview(item.text)}`,
                )
                .join("\n"),
              metadata: { count: rows.length, member: target.name },
            }
          }

          const seen =
            rows.length > 0
              ? new Set(
                  (
                    yield* Effect.promise(() =>
                      Inbox.markRead(
                        teamName,
                        target.name!,
                        rows.map((item) => item.id),
                      ),
                    )
                  ).map((item) => item.id),
                )
              : new Set<string>()
          if (rows.length === 0) {
            return {
              title: `Inbox: ${target.name}`,
              output: "Inbox is empty.",
              metadata: { count: 0, member: target.name },
            }
          }

          return {
            title: `Inbox: ${target.name}`,
            output: rows
              .map((item) =>
                [
                  `[${item.id}] from=${item.from} type=${item.type ?? "message"} priority=${item.priority ?? "normal"} read=${item.read || seen.has(item.id) ? "yes" : "no"} at=${stamp(item.timestamp)}`,
                  item.text,
                  item.metadata ? JSON.stringify(item.metadata, null, 2) : "",
                ]
                  .filter(Boolean)
                  .join("\n"),
              )
              .join("\n\n---\n\n"),
            metadata: { count: rows.length, member: target.name },
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof InboxParameters, InboxMetadata>
  }),
)

export const SubmitResultParameters = Schema.Struct({
  title: Schema.String,
  summary: Schema.String,
  status: Schema.Literals(RESULT_STATUS_VALUES),
  files_changed: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  evidence_tier: Schema.optional(Schema.Literals(EVIDENCE_TIER_VALUES)),
  evidence: Schema.optional(Schema.String),
  confidence: Schema.optional(Schema.Number),
  blockers: Schema.optional(Schema.String),
  task_id: Schema.optional(Schema.String),
})

type SubmitResultMetadata = {
  member?: string
  status?: string
  taskId?: string
}

function resultText(input: Schema.Schema.Type<typeof SubmitResultParameters>) {
  return [
    `Result: ${input.title}`,
    `Status: ${input.status}`,
    "",
    input.summary,
    input.files_changed?.length ? `Files changed: ${input.files_changed.join(", ")}` : "",
    input.evidence_tier ? `Evidence tier: ${input.evidence_tier}` : "",
    input.evidence ? `Evidence: ${input.evidence}` : "",
    typeof input.confidence === "number" ? `Confidence: ${Math.round(input.confidence * 100)}%` : "",
    input.blockers ? `Blockers: ${input.blockers}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

export const TeamSubmitResultTool = Tool.define<typeof SubmitResultParameters, SubmitResultMetadata, never>(
  "team_submit_result",
  Effect.gen(function* () {
    return {
      description:
        "Submit a structured task result to the team lead. Preferred over plain team_message for final results.",
      parameters: SubmitResultParameters,
      execute: (
        params: Schema.Schema.Type<typeof SubmitResultParameters>,
        ctx: Tool.Context<SubmitResultMetadata>,
      ) =>
        Effect.gen(function* () {
          const info = yield* Effect.promise(() => Team.findBySession(ctx.sessionID))
          if (!info || info.role !== "member" || !info.memberName) {
            return { title: "Error", output: "Only teammates can submit structured results.", metadata: {} }
          }

          // Re-parse through SubmittedResultSchema (the source of truth for the
          // ResultSubmitted event payload) so any drift between the tool's
          // Effect.Schema params and the zod event schema fails fast with a
          // clear error, and so the zod-only bounds (title.max(120),
          // summary.max(2000), confidence.min(0).max(1)) are enforced.
          let result: ReturnType<typeof SubmittedResultSchema.parse>
          try {
            result = SubmittedResultSchema.parse(params)
          } catch (err) {
            return {
              title: "Error",
              output: `Invalid result: ${err instanceof Error ? err.message : String(err)}`,
              metadata: {},
            }
          }

          if (params.task_id) {
            yield* Effect.promise(() => TeamTasks.complete(info.team.name, params.task_id!))
          }

          yield* Effect.promise(() =>
            TeamMessaging.send({
              teamName: info.team.name,
              from: info.memberName!,
              to: "lead",
              text: resultText(params),
              type: "result",
              metadata: { result },
            }),
          )

          yield* Effect.promise(() =>
            Bus.publish(TeamEvent.ResultSubmitted, {
              teamName: info.team.name,
              memberName: info.memberName!,
              result,
              taskId: params.task_id,
            }),
          )

          return {
            title: `Result submitted: ${params.title}`,
            output: `Submitted a structured ${params.status} result to the lead.${params.task_id ? ` Task "${params.task_id}" was marked completed.` : ""}`,
            metadata: { member: info.memberName, status: params.status, taskId: params.task_id },
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof SubmitResultParameters, SubmitResultMetadata>
  }),
)

export const WaitParameters = Schema.Struct({
  for: Schema.Literals(WAIT_FOR_VALUES),
  member: Schema.optional(SafeName),
  timeout_hint_seconds: Schema.optional(Bounded(5, 300)),
})

type WaitMetadata = {
  met?: boolean
  condition?: string
  member?: string
  count?: number
  from?: string
  status?: string
  members?: string[]
}

export const TeamWaitTool = Tool.define<typeof WaitParameters, WaitMetadata, never>(
  "team_wait",
  Effect.gen(function* () {
    return {
      description: "Check whether a team condition is already satisfied and return immediately with guidance.",
      parameters: WaitParameters,
      execute: (params: Schema.Schema.Type<typeof WaitParameters>, ctx: Tool.Context<WaitMetadata>) =>
        Effect.gen(function* () {
          const info = yield* Effect.promise(() => Team.findBySession(ctx.sessionID))
          if (!info) return { title: "Error", output: "You are not part of any team.", metadata: {} }

          switch (params.for) {
            case "any_message": {
              const target = inboxTarget(info, params.member)
              if (target.error || !target.name)
                return { title: "Error", output: target.error ?? "Invalid inbox target.", metadata: {} }
              const items = (yield* Effect.promise(() => Inbox.unread(info.team.name, target.name!))).toSorted(
                (a, b) => b.timestamp - a.timestamp,
              )
              if (items.length > 0) {
                return {
                  title: "Condition met",
                  output: `Found ${items.length} unread message(s) for "${target.name}". Latest from "${items[0]!.from}" at ${stamp(items[0]!.timestamp)}.`,
                  metadata: { met: true, condition: params.for, member: target.name, count: items.length },
                }
              }
              return {
                title: "Condition not met",
                output: `No unread messages for "${target.name}" yet. ${notice(params.timeout_hint_seconds)}`,
                metadata: { met: false, condition: params.for, member: target.name },
              }
            }
            case "result": {
              const target = info.role === "lead" ? "lead" : info.memberName!
              const all = yield* Effect.promise(() => Inbox.all(info.team.name, target))
              const items = all
                .filter((item) => item.type === "result" || !!item.metadata?.result)
                .filter((item) => (params.member ? item.from === params.member : true))
                .toSorted((a, b) => b.timestamp - a.timestamp)
              if (items.length > 0) {
                return {
                  title: "Condition met",
                  output: `Found a result from "${items[0]!.from}" at ${stamp(items[0]!.timestamp)}.`,
                  metadata: { met: true, condition: params.for, from: items[0]!.from },
                }
              }
              return {
                title: "Condition not met",
                output: `No result${params.member ? ` from "${params.member}"` : ""} has been submitted yet. ${notice(params.timeout_hint_seconds)}`,
                metadata: { met: false, condition: params.for, member: params.member },
              }
            }
            case "member_idle": {
              const target = memberTarget(info, params.member)
              if (target.error || !target.name)
                return { title: "Error", output: target.error ?? "Invalid member target.", metadata: {} }
              const team = yield* Effect.promise(() => Team.get(info.team.name))
              const member = team?.members.find((item) => item.name === target.name)
              if (!member) return { title: "Error", output: `Teammate "${target.name}" not found.`, metadata: {} }
              if (member.status === "ready") {
                return {
                  title: "Condition met",
                  output: `Teammate "${target.name}" is idle and ready for more work.`,
                  metadata: { met: true, condition: params.for, member: target.name },
                }
              }
              return {
                title: "Condition not met",
                output: `Teammate "${target.name}" is currently ${member.status}. ${notice(params.timeout_hint_seconds)}`,
                metadata: { met: false, condition: params.for, member: target.name, status: member.status },
              }
            }
            case "member_shutdown": {
              const target = memberTarget(info, params.member)
              if (target.error || !target.name)
                return { title: "Error", output: target.error ?? "Invalid member target.", metadata: {} }
              const team = yield* Effect.promise(() => Team.get(info.team.name))
              const member = team?.members.find((item) => item.name === target.name)
              if (!member) return { title: "Error", output: `Teammate "${target.name}" not found.`, metadata: {} }
              if (member.status === "shutdown") {
                return {
                  title: "Condition met",
                  output: `Teammate "${target.name}" has shut down.`,
                  metadata: { met: true, condition: params.for, member: target.name },
                }
              }
              return {
                title: "Condition not met",
                output: `Teammate "${target.name}" is ${member.status}. ${notice(params.timeout_hint_seconds)}`,
                metadata: { met: false, condition: params.for, member: target.name, status: member.status },
              }
            }
            case "all_shutdown": {
              const team = yield* Effect.promise(() => Team.get(info.team.name))
              const live = team?.members.filter((item) => item.status !== "shutdown") ?? []
              if (live.length === 0) {
                return {
                  title: "Condition met",
                  output: `All teammates in "${info.team.name}" have shut down.`,
                  metadata: { met: true, condition: params.for },
                }
              }
              return {
                title: "Condition not met",
                output: `Still waiting for shutdown from: ${live.map((item) => item.name).join(", ")}. ${notice(params.timeout_hint_seconds)}`,
                metadata: { met: false, condition: params.for, members: live.map((item) => item.name) },
              }
            }
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof WaitParameters, WaitMetadata>
  }),
)
