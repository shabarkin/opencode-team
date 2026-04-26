import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Inbox } from "../team/inbox"
import { Team } from "../team"
import { Bounded } from "./team-schema"

function picks(team: Awaited<ReturnType<typeof Team.get>>, members?: string[]) {
  if (!team) return { ok: false as const, error: "Team not found." }
  if (!members?.length) {
    return {
      ok: true as const,
      names: team.members.filter((member) => member.status !== "shutdown").map((member) => member.name),
    }
  }

  const names = [...new Set(members)]
  const miss = names.filter((name) => !team.members.some((member) => member.name === name))
  if (miss.length > 0) {
    return { ok: false as const, error: `Unknown teammate(s): ${miss.join(", ")}.` }
  }
  return { ok: true as const, names }
}

function latest(items: Awaited<ReturnType<typeof Inbox.all>>, name: string) {
  return items
    .filter((item) => item.from === name)
    .filter((item) => item.type === "result" || !!item.metadata?.result)
    .toSorted((a, b) => b.timestamp - a.timestamp)[0]
}

function current(
  member: NonNullable<Awaited<ReturnType<typeof Team.get>>>["members"][number],
  items: Awaited<ReturnType<typeof Inbox.all>>,
) {
  const item = latest(items, member.name)
  if (!item) return
  if (typeof member.assigned_at !== "number") return item
  if (item.timestamp >= member.assigned_at) return item
}

function picked(team: NonNullable<Awaited<ReturnType<typeof Team.get>>>, names: string[], waive: string[]) {
  const miss = waive.filter((name) => !names.includes(name) || !team.members.some((member) => member.name === name))
  if (miss.length > 0) {
    return { ok: false as const, error: `Unknown or unselected teammate(s) in waive: ${miss.join(", ")}.` }
  }
  return { ok: true as const, names: new Set(waive) }
}

function scan(
  team: NonNullable<Awaited<ReturnType<typeof Team.get>>>,
  items: Awaited<ReturnType<typeof Inbox.all>>,
  names: string[],
  opts: { strict: boolean; idle: boolean; waive: Set<string> },
) {
  const collected: string[] = []
  const pending: string[] = []
  const notes: string[] = []

  for (const name of names) {
    const member = team.members.find((item) => item.name === name)
    if (!member) continue
    const item = current(member, items)
    if (item) {
      collected.push(name)
      notes.push([`## ${name}`, item.text].join("\n"))
      continue
    }
    if (opts.waive.has(name)) {
      collected.push(name)
      notes.push(`## ${name}\nWaived by lead. No fresh structured result was required for this teammate.`)
      continue
    }
    if ((member.status === "ready" || member.status === "shutdown") && (!opts.strict || opts.idle)) {
      collected.push(name)
      notes.push(`## ${name}\n"${name}" is ${member.status} with no structured result yet.`)
      continue
    }
    pending.push(name)
    if (opts.strict) {
      notes.push(`## ${name}\nStill waiting for a fresh structured result after the latest assignment.`)
    }
  }

  return { collected, pending, notes }
}

function text(state: ReturnType<typeof scan>, timedOut: boolean) {
  return [
    `Collected: ${state.collected.length > 0 ? state.collected.join(", ") : "none"}`,
    `Pending: ${state.pending.length > 0 ? state.pending.join(", ") : "none"}`,
    "",
    ...state.notes,
    state.notes.length > 0 ? "" : "No teammate results were available.",
    timedOut ? "Timed out waiting for the remaining teammates." : "",
    !timedOut && state.pending.length === 0
      ? "All results collected. Produce your final synthesis ONCE. After delivery, proceed to team_shutdown_all and team_cleanup. Do NOT re-summarize."
      : "",
  ]
    .filter(Boolean)
    .join("\n")
}

export const Parameters = Schema.Struct({
  members: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Optional teammate names to wait for. Defaults to all non-shutdown teammates.",
  }),
  require_structured_result: Schema.optional(Schema.Boolean).annotate({
    description: "If true, only fresh structured results count as collected unless explicitly waived.",
  }),
  allow_idle_without_result: Schema.optional(Schema.Boolean).annotate({
    description: "If true, ready or shutdown teammates may still count as collected without a fresh result.",
  }),
  waive: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Optional teammate names to treat as collected without a fresh structured result.",
  }),
  timeout_seconds: Schema.optional(Bounded(10, 600)),
  poll_interval_seconds: Schema.optional(Bounded(5, 60)),
})

type Metadata = {
  collected?: string[]
  pending?: string[]
  strict?: boolean
  timed_out?: boolean
  waive?: string[]
}

export const TeamCollectTool = Tool.define<typeof Parameters, Metadata, never>(
  "team_collect",
  Effect.gen(function* () {
    return {
      description:
        "Wait for teammate results and return a consolidated collection summary. " +
        "This is the lead's synthesis gate: use it after spawning teammates and before you synthesize the final answer, instead of replacing teammate work with fresh hands-on investigation by the lead.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const info = yield* Effect.promise(() => Team.findBySession(ctx.sessionID))
          if (!info || info.role !== "lead") {
            return { title: "Error", output: "Only the team lead can collect teammate results.", metadata: {} }
          }

          const team = yield* Effect.promise(() => Team.get(info.team.name))
          const target = picks(team, params.members as string[] | undefined)
          if (!target.ok) {
            return { title: "Error", output: target.error, metadata: {} }
          }
          if (target.names.length === 0) {
            return {
              title: "Nothing to collect",
              output: "There are no active teammates to collect from.",
              metadata: { collected: [], pending: [], timed_out: false },
            }
          }
          if (!team) {
            return { title: "Error", output: `Team "${info.team.name}" not found.`, metadata: {} }
          }

          const waive = picked(team, target.names, [...new Set((params.waive as string[] | undefined) ?? [])])
          if (!waive.ok) {
            return { title: "Error", output: waive.error, metadata: {} }
          }

          const strict = params.require_structured_result ?? team.collect_strict ?? false
          const idle = params.allow_idle_without_result ?? !strict

          yield* Effect.promise(() => Team.setTeamPhase(info.team.name, "synthesis"))

          const stop = Date.now() + (params.timeout_seconds ?? 300) * 1000
          const poll = (params.poll_interval_seconds ?? 10) * 1000

          while (true) {
            const next = yield* Effect.promise(() => Team.get(info.team.name))
            if (!next) {
              return { title: "Error", output: `Team "${info.team.name}" not found.`, metadata: {} }
            }

            const items = yield* Effect.promise(() => Inbox.all(info.team.name, "lead"))
            const state = scan(next, items, target.names, {
              strict,
              idle,
              waive: waive.names,
            })
            if (state.pending.length === 0) {
              yield* Effect.promise(() => Team.setDelivered(info.team.name, true))
              return {
                title: "Collected team results",
                output: text(state, false),
                metadata: {
                  collected: state.collected,
                  pending: state.pending,
                  strict,
                  timed_out: false,
                  waive: [...waive.names],
                },
              }
            }

            if (Date.now() >= stop) {
              return {
                title: "Team collection timed out",
                output: text(state, true),
                metadata: {
                  collected: state.collected,
                  pending: state.pending,
                  strict,
                  timed_out: true,
                  waive: [...waive.names],
                },
              }
            }

            yield* Effect.promise(() => Bun.sleep(poll))
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
