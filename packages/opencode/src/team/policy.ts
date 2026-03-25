import { Plugin } from "@/plugin"

type SpawnInput = {
  teamName: string
  name: string
  agent: string
  model: string
  requestedBy: string
  currentMemberCount: number
}

type MessageInput = {
  teamName: string
  from: string
  to: string
  text: string
  type?: string
  priority?: string
}

export namespace TeamPolicy {
  export async function memberSpawning(input: SpawnInput): Promise<{ allow: boolean; reason?: string }> {
    return Plugin.trigger("team.member.spawning", input, { allow: true, reason: undefined as string | undefined })
  }

  export async function memberSpawned(input: { teamName: string; name: string; agent: string; sessionID: string }) {
    await Plugin.trigger("team.member.spawned", input, {})
  }

  export async function messageSending(
    input: MessageInput,
  ): Promise<{ text: string; allow: boolean; reason?: string }> {
    return Plugin.trigger(
      "team.message.sending",
      {
        teamName: input.teamName,
        from: input.from,
        to: input.to,
        type: input.type,
        priority: input.priority,
      },
      { text: input.text, allow: true, reason: undefined as string | undefined },
    )
  }

  export async function memberIdle(input: {
    teamName: string
    name: string
    agent: string
    executionStatus: string
    runtime: number
  }) {
    await Plugin.trigger("team.member.idle", input, {})
  }

  export async function shutdownBefore(input: {
    teamName: string
    name: string
    tasksRemaining: number
  }): Promise<{ allow: boolean; reason?: string }> {
    return Plugin.trigger("team.shutdown.before", input, { allow: true, reason: undefined as string | undefined })
  }

  export async function taskClaimed(input: {
    teamName: string
    taskId: string
    taskContent: string
    claimedBy: string
  }) {
    await Plugin.trigger("team.task.claimed", input, {})
  }

  export async function spawnRequested(input: {
    teamName: string
    requestedBy: string
    agent: string
    rationale: string
  }): Promise<{ action: "approve" | "deny" | "ask_lead"; reason?: string }> {
    return Plugin.trigger("team.spawn.requested", input, {
      action: "ask_lead" as const,
      reason: undefined as string | undefined,
    })
  }

  export async function conflictDetected(input: {
    teamName: string
    file: string
    editors: string[]
  }): Promise<{ action: "warn" | "block" | "ignore" }> {
    return Plugin.trigger("team.conflict.detected", input, { action: "warn" as const })
  }

  /**
   * Plugin hook for extra scope checks.
   * Primary enforcement happens via session permission rules set at spawn time.
   */
  export async function pathAccess(input: {
    teamName: string
    memberName: string
    filePath: string
    operation: "read" | "write"
  }): Promise<{ allow: boolean; reason?: string }> {
    const { Team } = await import("./index")
    const { TeamScope } = await import("./scope")
    const { Session } = await import("../session")
    const { SessionID } = await import("../session/schema")

    const team = await Team.get(input.teamName)
    const member = team?.members.find((item) => item.name === input.memberName)
    if (!team || !member) return { allow: true }

    const scope = TeamScope.withDefaults(TeamScope.merge(team.scope, member.scope))
    if (!scope.path_excludes?.length && !scope.path_includes?.length) return { allow: true }

    const session = await Session.get(SessionID.make(member.sessionID)).catch(() => undefined)
    return TeamScope.checkPath(input.filePath, scope, session?.directory ?? member.worktreePath ?? "/")
  }

  /**
   * Plugin hook for extra scope checks.
   * Primary enforcement happens via session permission rules set at spawn time.
   */
  export async function bashCommand(input: {
    teamName: string
    memberName: string
    command: string
  }): Promise<{ allow: boolean; reason?: string }> {
    const { Team } = await import("./index")
    const { TeamScope } = await import("./scope")

    const team = await Team.get(input.teamName)
    const member = team?.members.find((item) => item.name === input.memberName)
    if (!team || !member) return { allow: true }

    const scope = TeamScope.withDefaults(TeamScope.merge(team.scope, member.scope))
    if (!scope.bash_allowlist?.length) return { allow: true }
    return TeamScope.checkBashCommand(input.command, scope)
  }

  export async function checkBudget(
    teamName: string,
  ): Promise<{ action: "continue" | "warn" | "pause_all" | "shutdown_all"; message?: string }> {
    const { Team } = await import("./index")
    const { TeamMessaging } = await import("./messaging")
    const costs = await Team.cost(teamName)
    const memberCosts = Object.fromEntries(Object.entries(costs.perMember).map(([name, item]) => [name, item.cost]))
    const result = await Plugin.trigger(
      "team.budget.check",
      {
        teamName,
        currentCost: costs.total.cost,
        memberCosts,
      },
      { action: "continue" as const, message: undefined as string | undefined },
    )

    if (result.action === "continue") return result

    const message = result.message ?? `Budget action "${result.action}" triggered at $${costs.total.cost.toFixed(2)}.`
    if (result.action === "warn") {
      await TeamMessaging.send({ teamName, from: "system", to: "lead", text: `[Budget] ${message}` }).catch(() => {})
      return result
    }

    if (result.action === "pause_all") {
      await Team.pauseAll(teamName, message)
      await TeamMessaging.send({ teamName, from: "system", to: "lead", text: `[Budget] ${message}` }).catch(() => {})
      return result
    }

    await Team.forceShutdownAll(teamName, message)
    await TeamMessaging.send({ teamName, from: "system", to: "lead", text: `[Budget] ${message}` }).catch(() => {})
    return result
  }
}
