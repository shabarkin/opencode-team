import z from "zod"
import { Tool } from "./tool"
import { Team, TeamTasks } from "../team"
import { Inbox } from "../team/inbox"
import { Session } from "../session"

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

    // Member status table
    const members = await Promise.all(
      team.members.map(async (m) => {
        const unread = await Inbox.unread(team.name, m.name).catch(() => [])
        const elapsed = Math.round((now - team.created) / 60000)
        return [
          `  ${icon(m.status)} ${m.name}`,
          `agent=${m.agent}`,
          `status=${m.status}`,
          `exec=${m.execution_status ?? "idle"}`,
          m.model ?? "",
          m.planApproval && m.planApproval !== "none" ? `plan=${m.planApproval}` : "",
          unread.length > 0 ? `${unread.length} unread` : "",
          `${elapsed}m`,
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

    // Cost estimation from session messages
    const cost = await estimateCost(team, ctx)

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

    if (tasks.length > 0) {
      sections.push("")
      for (const t of tasks) {
        const assignee = t.assignee ? ` (${t.assignee})` : ""
        const deps = t.depends_on?.length ? ` [deps: ${t.depends_on.join(", ")}]` : ""
        sections.push(`  [${t.id}] ${t.content} — ${t.status}${assignee} (${t.priority})${deps}`)
      }
    }

    if (cost) {
      sections.push("", `Estimated cost: ${cost}`)
    }

    return {
      title: `Team status: ${team.name}`,
      output: sections.join("\n"),
      metadata: {
        teamName: team.name,
        memberCount: team.members.length,
        taskCount: tasks.length,
      },
    }
  },
})

function icon(status: string): string {
  switch (status) {
    case "busy":
      return "*"
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

async function estimateCost(
  team: { members: Array<{ sessionID: string }>; leadSessionID: string },
  ctx: { sessionID: any },
): Promise<string | undefined> {
  try {
    const { SessionID } = await import("../session/schema")
    let total = 0

    // Sum lead session cost
    const leadMsgs = await Session.messages({ sessionID: SessionID.make(team.leadSessionID) }).catch(() => [])
    for (const m of leadMsgs) {
      if (m.info.role === "assistant") {
        const a = m.info as { cost?: number }
        if (a.cost) total += a.cost
      }
    }

    // Sum member session costs
    for (const member of team.members) {
      const msgs = await Session.messages({ sessionID: SessionID.make(member.sessionID) }).catch(() => [])
      for (const m of msgs) {
        if (m.info.role === "assistant") {
          const a = m.info as { cost?: number }
          if (a.cost) total += a.cost
        }
      }
    }

    if (total === 0) return undefined
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(total)
  } catch {
    return undefined
  }
}
