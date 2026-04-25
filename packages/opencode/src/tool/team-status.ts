import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Team, TeamTasks } from "../team"
import { Inbox } from "../team/inbox"
import { teamStatusIcon } from "../team/status-view"

export const Parameters = Schema.Struct({})

type Metadata = {
  teamName?: string
  memberCount?: number
  taskCount?: number
  pendingSpawnRequestCount?: number
}

export const TeamStatusTool = Tool.define<typeof Parameters, Metadata, never>(
  "team_status",
  Effect.gen(function* () {
    return {
      description:
        "Get a comprehensive snapshot of the current team state including all members, " +
        "their status, the task board, unread message counts, and spend summaries. " +
        "Use this as the lead's primary monitoring tool before making coordination decisions, reassigning work, or collecting results.",
      parameters: Parameters,
      execute: (_params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const info = yield* Effect.promise(() => Team.findBySession(ctx.sessionID))
          if (!info) {
            return { title: "Error", output: "You are not part of any team.", metadata: {} }
          }

          const team = yield* Effect.promise(() => Team.get(info.team.name))
          if (!team) {
            return { title: "Error", output: `Team "${info.team.name}" not found.`, metadata: {} }
          }

          const tasks = yield* Effect.promise(() => TeamTasks.list(team.name))
          const now = Date.now()
          const costs = yield* Effect.promise(() => Team.cost(team.name))
          const burn = now > team.created ? (costs.total.cost / (now - team.created)) * 60 * 60 * 1000 : 0

          const members = yield* Effect.promise(() =>
            Promise.all(
              team.members.map(async (m) => {
                const unread = await Inbox.unread(team.name, m.name).catch(() => [])
                const mins = Math.round((now - (m.started ?? m.updated ?? team.created)) / 60000)
                const spend = costs.perMember[m.name]?.cost ?? 0
                return [
                  `  ${teamStatusIcon(m.status)} ${m.name}`,
                  `agent=${m.agent}`,
                  `status=${m.status}`,
                  `exec=${m.execution_status ?? "idle"}`,
                  m.model ?? "",
                  m.worktreeBranch ? `worktree=${m.worktreeBranch}` : "",
                  m.worktreeBranch ? `merge=${m.mergeStatus ?? "pending"}` : "",
                  m.mergeError ? `merge_error=${m.mergeError.split("\n")[0]}` : "",
                  m.phase ? `phase=${m.phase}` : "",
                  m.planApproval && m.planApproval !== "none" ? `plan=${m.planApproval}` : "",
                  m.checkpoint && m.checkpoint !== "none" ? `checkpoint=${m.checkpoint}` : "",
                  m.activeDelegations ? `delegations=${m.activeDelegations}` : "",
                  m.last_result_at ? `last_result=${new Date(m.last_result_at).toISOString()}` : "",
                  m.error_kind ? `error_kind=${m.error_kind}` : "",
                  spend > 0 ? `cost=${money(spend)}` : "",
                  unread.length > 0 ? `${unread.length} unread` : "",
                  `${mins}m`,
                  m.status === "error" ? "→ team_restart or team_shutdown" : "",
                  m.execution_status === "timed_out" ? "→ review session log" : "",
                ]
                  .filter(Boolean)
                  .join(" | ")
              }),
            ),
          )

          const leadUnread = yield* Effect.promise(() => Inbox.unread(team.name, "lead").catch(() => []))

          const pending = tasks.filter((t) => t.status === "pending").length
          const progress = tasks.filter((t) => t.status === "in_progress").length
          const completed = tasks.filter((t) => t.status === "completed").length
          const blocked = tasks.filter((t) => t.status === "blocked").length
          const cancelled = tasks.filter((t) => t.status === "cancelled").length

          const sections = [
            `Team: ${team.name}${team.delegate ? " [DELEGATE MODE]" : ""}${team.worktrees ? " [WORKTREES]" : ""}`,
            `Role: ${info.role}${info.memberName ? ` (${info.memberName})` : ""}`,
            `team_phase=${team.team_phase ?? "none"}`,
            `delivered=${team.delivered ? "yes" : "no"}`,
            `output_format=${team.output_format ?? "free"}`,
            `Created: ${new Date(team.created).toISOString()}`,
            "",
            `Members (${team.members.length}):`,
            ...members,
            "",
            `Lead inbox: ${leadUnread.length} unread messages`,
            "",
            `Tasks: ${tasks.length} total — ${pending} pending, ${progress} in progress, ${completed} completed, ${blocked} blocked${cancelled ? `, ${cancelled} cancelled` : ""}`,
          ]

          if (team.pending_spawn_requests?.length) {
            sections.push("", `Pending spawn requests (${team.pending_spawn_requests.length}):`)
            for (const request of team.pending_spawn_requests) {
              sections.push(
                `  [${request.id}] ${request.requested_by} → ${request.agent}${request.name ? ` as ${request.name}` : ""} — ${request.rationale}`,
              )
            }
          }

          if (tasks.length > 0) {
            sections.push("")
            for (const t of tasks) {
              const assignee = t.assignee ? ` (${t.assignee})` : ""
              const deps = t.depends_on?.length ? ` [deps: ${t.depends_on.join(", ")}]` : ""
              sections.push(`  [${t.id}] ${t.content} — ${t.status}${assignee} (${t.priority})${deps}`)
            }
          }

          sections.push(
            "",
            "Costs:",
            `  total=${money(costs.total.cost)} | projected 1h=${money(burn)}`,
            `  lead=${money(costs.perMember.lead?.cost ?? 0)}`,
            ...team.members.map((member) => `  ${member.name}=${money(costs.perMember[member.name]?.cost ?? 0)}`),
          )

          const threads = yield* Effect.promise(() =>
            listThreads(
              team.name,
              team.members.map((member) => member.name),
            ),
          )
          if (threads.length > 0) {
            sections.push("", `Threads (${threads.length}):`)
            for (const thread of threads) {
              sections.push(`  [${thread.id}] ${thread.people.join(", ")} — ${thread.text}`)
            }
          }

          return {
            title: `Team status: ${team.name}`,
            output: sections.join("\n"),
            metadata: {
              teamName: team.name,
              memberCount: team.members.length,
              taskCount: tasks.length,
              pendingSpawnRequestCount: team.pending_spawn_requests?.length ?? 0,
            },
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value)
}

async function listThreads(teamName: string, members: string[]) {
  const mail = await Promise.all(
    ["lead", ...members].map(async (name) => {
      const items = await Inbox.all(teamName, name).catch(() => [])
      return items.filter((item) => !item.text.startsWith("[receipt]")).map((item) => ({ ...item, to: name }))
    }),
  )

  const map = new Map<string, { id: string; text: string; time: number; people: Set<string> }>()
  for (const item of mail.flat()) {
    const id = item.threadId ?? item.replyTo ?? item.id
    const next = map.get(id) ?? { id, text: item.text, time: item.timestamp, people: new Set<string>() }
    if (item.timestamp >= next.time) {
      next.text = item.text
      next.time = item.timestamp
    }
    next.people.add(item.from)
    next.people.add(item.to)
    map.set(id, next)
  }

  return [...map.values()]
    .sort((a, b) => b.time - a.time)
    .slice(0, 5)
    .map((item) => ({
      id: item.id,
      text: item.text,
      people: [...item.people].sort(),
    }))
}
