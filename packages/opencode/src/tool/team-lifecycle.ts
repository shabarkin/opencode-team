import z from "zod"
import { Tool } from "./tool"
import { MemberPhase, Team, TeamTasks } from "../team"
import { Inbox } from "../team/inbox"

const NOISE_MIN = 5
const NOISE_AGE = 15 * 60 * 1000
const ACTIVE_EXEC = new Set(["starting", "running", "cancel_requested", "cancelling", "completing"])
const ACTIVE_PHASE = new Set(["researching", "implementing", "testing", "waiting_approval"])
const DONE_TASK = new Set(["completed", "cancelled"])

function active(
  member: NonNullable<Awaited<ReturnType<typeof Team.get>>>["members"][number],
  tasks: Awaited<ReturnType<typeof TeamTasks.list>>,
) {
  if (member.status === "busy" || member.status === "paused") return true
  if (member.execution_status && ACTIVE_EXEC.has(member.execution_status)) return true
  if (member.phase && ACTIVE_PHASE.has(member.phase)) return true
  return tasks.some((task) => task.assignee === member.name && task.status === "in_progress")
}

function done(
  member: NonNullable<Awaited<ReturnType<typeof Team.get>>>["members"][number],
  tasks: Awaited<ReturnType<typeof TeamTasks.list>>,
  items: Awaited<ReturnType<typeof Inbox.all>>,
) {
  if (member.status === "shutdown_requested") return true
  const mark = member.assigned_at ?? 0
  if (typeof member.last_result_at === "number" && member.last_result_at >= mark) return true
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
        return /timeout|failed|failure|crash|conflict|noise|undelivered|backlog/i.test(item.text)
      }
      if (item.type !== "error") return false
      return /timeout|failed|failure|crash|conflict|blocked|error/i.test(item.text)
    }).length >= NOISE_MIN
  )
}

export const TeamShutdownAllTool = Tool.define("team_shutdown_all", {
  description: "Request shutdown for every active teammate, or force all teammates directly into shutdown.",
  parameters: z.object({
    reason: z.string().optional(),
    force: z.boolean().optional().describe("Skip graceful drain and force every member into shutdown"),
  }),
  async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, unknown> }> {
    const info = await Team.findBySession(ctx.sessionID)
    if (!info || info.role !== "lead") {
      return { title: "Error", output: "Only the team lead can shut down all teammates.", metadata: {} }
    }

    const team = await Team.get(info.team.name)
    const live = team?.members.filter((member) => member.status !== "shutdown") ?? []
    const tasks = await TeamTasks.list(info.team.name)
    const mail = await Inbox.all(info.team.name, "lead").catch(() => [])
    const wait = live.filter((member) => active(member, tasks) || !done(member, tasks, mail))
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
      await Team.forceShutdownAll(info.team.name, params.reason)
      await Team.setTeamPhase(info.team.name, "delivery")
      return {
        title: "Shutdown requested for all teammates",
        output: [
          `Force shutdown applied to ${live.length} teammate(s).`,
          "Use this only when repeated errors/noise are derailing the team or you explicitly need an emergency stop.",
          "After final delivery, call team_cleanup to end team mode and resume normal non-team chat unless the user asks for a team again.",
        ].join("\n"),
        metadata: { count: live.length, force: true },
      }
    }

    const blocked: string[] = []
    let count = 0
    for (const member of live) {
      const result = await Team.shutdown({
        teamName: info.team.name,
        memberName: member.name,
        reason: params.reason,
      })
      if (result.status === "requested" || result.status === "already_shutdown") {
        count++
        continue
      }
      if (result.status === "blocked") {
        blocked.push(`${member.name}: ${result.reason ?? "blocked by policy"}`)
      }
    }

    await Team.setTeamPhase(info.team.name, "delivery")

    return {
      title: "Shutdown requested for all teammates",
      output: [
        `Requested shutdown for ${count} teammate(s).`,
        storm
          ? "Repeated error/noise detected in the channel, so shutdown is allowed even with active work."
          : "All teammates appear to be done or ready to wrap up, so shutdown is safe.",
        blocked.length > 0 ? `Blocked: ${blocked.join("; ")}` : "",
        "After final delivery, call team_cleanup to end team mode and resume normal non-team chat unless the user asks for a team again.",
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { count, blocked: blocked.length, force: false, noisy: storm },
    }
  },
})

export const TeamPhaseTool = Tool.define("team_phase", {
  description: "Report your current work phase to the team lead.",
  parameters: z.object({ phase: MemberPhase }),
  async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, unknown> }> {
    const info = await Team.findBySession(ctx.sessionID)
    if (!info || info.role !== "member" || !info.memberName) {
      return { title: "Error", output: "Only teammates can report a work phase.", metadata: {} }
    }

    await Team.setMemberPhase(info.team.name, info.memberName, params.phase)
    return {
      title: `Phase updated: ${params.phase}`,
      output: `Reported phase "${params.phase}" for teammate "${info.memberName}".`,
      metadata: { member: info.memberName, phase: params.phase },
    }
  },
})
