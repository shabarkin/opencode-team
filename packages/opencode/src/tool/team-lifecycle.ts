import z from "zod"
import { Tool } from "./tool"
import { MemberPhase, Team } from "../team"

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
    if (params.force) {
      await Team.forceShutdownAll(info.team.name, params.reason)
      await Team.setTeamPhase(info.team.name, "delivery")
      return {
        title: "Shutdown requested for all teammates",
        output: `Force shutdown applied to ${live.length} teammate(s).`,
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
        blocked.length > 0 ? `Blocked: ${blocked.join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { count, blocked: blocked.length, force: false },
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
