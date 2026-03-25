import z from "zod"
import { Tool } from "./tool"
import { Team, TeamTasks } from "../team"
import { Inbox } from "../team/inbox"

export const TeamStatusTool = Tool.define("team_status", {
  description:
    "Get a comprehensive snapshot of the current team state including all members, " +
    "their status, the task board, unread message counts, and cost estimates. " +
    "Use this to understand what the team is doing before making coordination decisions.",
  parameters: z.object({}),
  async execute(_params, ctx): Promise<{ title: string; output: string; metadata: Record<string, any> }> {
    const info = await Team.findBySession(ctx.sessionID)
    if (!info) {
      return { title: "Error", output: "You are not part of any team.", metadata: {} }
    }

    const team = await Team.get(info.team.name)
    if (!team) {
      return { title: "Error", output: `Team "${info.team.name}" not found.`, metadata: {} }
    }

    const tasks = await TeamTasks.list(team.name)
    const now = Date.now()
    const costs = await Team.cost(team.name)
    const cap = team.maxCost ?? team.members.reduce((sum, member) => sum + (member.maxCost ?? 0), 0)
    const burn = now > team.created ? (costs.total.cost / (now - team.created)) * 60 * 60 * 1000 : 0

    // Member status table
    const members = await Promise.all(
      team.members.map(async (m) => {
        const unread = await Inbox.unread(team.name, m.name).catch(() => [])
        const mins = Math.round((now - (m.started ?? m.updated ?? team.created)) / 60000)
        const spend = costs.perMember[m.name]?.cost ?? 0
        const usage =
          m.maxCost && m.maxCost > 0 ? `${Math.round((spend / m.maxCost) * 100)}%/$${m.maxCost.toFixed(2)}` : ""
        return [
          `  ${icon(m.status)} ${m.name}`,
          `agent=${m.agent}`,
          `status=${m.status}`,
          `exec=${m.execution_status ?? "idle"}`,
          m.model ?? "",
          m.worktreeBranch ? `worktree=${m.worktreeBranch}` : "",
          m.phase ? `phase=${m.phase}` : "",
          m.planApproval && m.planApproval !== "none" ? `plan=${m.planApproval}` : "",
          m.checkpoint && m.checkpoint !== "none" ? `checkpoint=${m.checkpoint}` : "",
          m.activeDelegations ? `delegations=${m.activeDelegations}` : "",
          m.last_result_at ? `last_result=${new Date(m.last_result_at).toISOString()}` : "",
          m.error_kind ? `error_kind=${m.error_kind}` : "",
          spend > 0 ? `cost=${money(spend)}` : "",
          usage ? `budget=${usage}` : "",
          unread.length > 0 ? `${unread.length} unread` : "",
          `${mins}m`,
          m.status === "error" ? "→ team_restart or team_shutdown" : "",
          m.execution_status === "timed_out" ? "→ review session log" : "",
        ]
          .filter(Boolean)
          .join(" | ")
      }),
    )

    // Lead inbox
    const leadUnread = await Inbox.unread(team.name, "lead").catch(() => [])

    // Task summary
    const pending = tasks.filter((t) => t.status === "pending").length
    const progress = tasks.filter((t) => t.status === "in_progress").length
    const completed = tasks.filter((t) => t.status === "completed").length
    const blocked = tasks.filter((t) => t.status === "blocked").length
    const cancelled = tasks.filter((t) => t.status === "cancelled").length

    const sections = [
      `Team: ${team.name}${team.delegate ? " [DELEGATE MODE]" : ""}`,
      `Role: ${info.role}${info.memberName ? ` (${info.memberName})` : ""}`,
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
      ...team.members.map((member) => {
        const spend = costs.perMember[member.name]?.cost ?? 0
        const usage =
          member.maxCost && member.maxCost > 0
            ? ` of $${member.maxCost.toFixed(2)} (${Math.round((spend / member.maxCost) * 100)}%)`
            : ""
        return `  ${member.name}=${money(spend)}${usage}`
      }),
    )

    if (cap > 0) {
      sections.push(`Budget cap: $${cap.toFixed(2)}`)
      sections.push(`Budget usage: ${Math.round((costs.total.cost / cap) * 100)}% of $${cap.toFixed(2)}`)
    }

    const threads = await listThreads(
      team.name,
      team.members.map((member) => member.name),
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
  },
})

function icon(status: string): string {
  switch (status) {
    case "busy":
      return "*"
    case "paused":
      return "||"
    case "ready":
      return "o"
    case "shutdown_requested":
      return "!"
    case "shutdown":
      return "x"
    case "error":
      return "E"
    default:
      return "?"
  }
}

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
