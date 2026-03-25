import z from "zod"
import { Inbox } from "../team/inbox"
import { MemberNameSchema, Team } from "../team"
import { Tool } from "./tool"

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

function scan(
  team: NonNullable<Awaited<ReturnType<typeof Team.get>>>,
  items: Awaited<ReturnType<typeof Inbox.all>>,
  names: string[],
) {
  const collected: string[] = []
  const pending: string[] = []
  const notes: string[] = []

  for (const name of names) {
    const member = team.members.find((item) => item.name === name)
    if (!member) continue
    const item = latest(items, name)
    if (item) {
      collected.push(name)
      notes.push([`## ${name}`, item.text].join("\n"))
      continue
    }
    if (member.status === "ready" || member.status === "shutdown") {
      collected.push(name)
      notes.push(`## ${name}\n"${name}" is ${member.status} with no structured result yet.`)
      continue
    }
    pending.push(name)
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

export const TeamCollectTool = Tool.define("team_collect", {
  description:
    "Wait for teammate results and return a consolidated collection summary. " +
    "Use this after spawning teammates and before you synthesize the final answer.",
  parameters: z.object({
    members: z
      .array(MemberNameSchema)
      .optional()
      .describe("Optional teammate names to wait for. Defaults to all non-shutdown teammates."),
    timeout_seconds: z.number().int().min(10).max(600).optional(),
    poll_interval_seconds: z.number().int().min(5).max(60).optional(),
  }),
  async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, unknown> }> {
    const info = await Team.findBySession(ctx.sessionID)
    if (!info || info.role !== "lead") {
      return { title: "Error", output: "Only the team lead can collect teammate results.", metadata: {} }
    }

    const team = await Team.get(info.team.name)
    const target = picks(team, params.members)
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

    await Team.setTeamPhase(info.team.name, "synthesis")

    const stop = Date.now() + (params.timeout_seconds ?? 300) * 1000
    const poll = (params.poll_interval_seconds ?? 10) * 1000

    while (true) {
      const next = await Team.get(info.team.name)
      if (!next) {
        return { title: "Error", output: `Team "${info.team.name}" not found.`, metadata: {} }
      }

      const state = scan(next, await Inbox.all(info.team.name, "lead"), target.names)
      if (state.pending.length === 0) {
        await Team.setDelivered(info.team.name, true)
        return {
          title: "Collected team results",
          output: text(state, false),
          metadata: { collected: state.collected, pending: state.pending, timed_out: false },
        }
      }

      if (Date.now() >= stop) {
        return {
          title: "Team collection timed out",
          output: text(state, true),
          metadata: { collected: state.collected, pending: state.pending, timed_out: true },
        }
      }

      await Bun.sleep(poll)
    }
  },
})
