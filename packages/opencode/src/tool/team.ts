import z from "zod"
import { Tool } from "./tool"
import { Team, TeamTasks, TeamNameSchema, MemberNameSchema, addDelegateRules, type TeamTask } from "../team"
import { TeamMessaging } from "../team/messaging"
import { Session } from "../session"
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { Bus } from "../bus"
import { TeamEvent } from "../team/events"
import { TeamStatusTool } from "./team-status"
import { TeamNotepadTool } from "./team-notepad"

/**
 * Create a new agent team. Only the lead session should call this.
 */
export const TeamCreateTool = Tool.define("team_create", {
  description:
    "Create a new agent team for coordinating parallel work across multiple sessions. " +
    "You become the team lead. After creating a team, use team_spawn to add teammates, " +
    "and team_tasks to create a shared task list.",
  parameters: z.object({
    name: TeamNameSchema.describe("Team name — lowercase, hyphens allowed. E.g. 'auth-review', 'feature-impl'"),
    tasks: z
      .array(
        z.object({
          id: z.string(),
          content: z.string(),
          priority: z.enum(["high", "medium", "low"]),
          depends_on: z.array(z.string()).optional(),
        }),
      )
      .optional()
      .describe("Optional initial task list for the team"),
    delegate: z
      .boolean()
      .optional()
      .describe(
        "If true, enables delegate mode: the lead is restricted to coordination-only tools " +
          "(team_*, read, glob, grep, list). The lead cannot write, edit, or run bash commands. " +
          "Use this when you want the lead to focus entirely on orchestration.",
      ),
  }),
  async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, any> }> {
    // Constraint: no nested teams — teammates cannot create teams
    const existingTeam = await Team.findBySession(ctx.sessionID)
    if (existingTeam && existingTeam.role === "member") {
      return {
        title: "Error",
        output: "Teammates cannot create new teams. Only the lead session or an independent session can create a team.",
        metadata: {},
      }
    }
    if (existingTeam && existingTeam.role === "lead") {
      return {
        title: "Error",
        output: `You are already leading team "${existingTeam.team.name}". Only one team per session is allowed.`,
        metadata: {},
      }
    }

    const team = await Team.create({
      name: params.name,
      leadSessionID: ctx.sessionID,
      delegate: params.delegate,
    })

    if (params.tasks?.length) {
      const tasks: TeamTask[] = params.tasks.map((t) => ({
        ...t,
        status: "pending" as const,
      }))
      await TeamTasks.add(params.name, tasks)
    }

    // Delegate mode: restrict the lead to coordination-only tools
    if (params.delegate) {
      const session = await Session.get(ctx.sessionID)
      await Session.setPermission({
        sessionID: ctx.sessionID,
        permission: addDelegateRules(session.permission ?? []),
      })
    }

    return {
      title: `Created team: ${params.name}`,
      output: [
        `Team "${params.name}" created. You are the lead.`,
        params.delegate ? "DELEGATE MODE: You are restricted to coordination tools only (no write/edit/bash)." : "",
        "",
        "Quick reference:",
        "  team_spawn        — Add a teammate (set agent, model, prompt, timeout)",
        "  team_status       — Full team snapshot (members, tasks, costs)",
        "  team_message      — Direct message a teammate (to: 'name')",
        "  team_broadcast    — Message all teammates",
        "  team_tasks        — View/add/complete shared tasks",
        "  team_claim        — Claim a pending task",
        "  team_notepad      — Read/write shared team knowledge",
        "  team_health       — Diagnose stuck members, blocked tasks",
        "  team_restart      — Re-engage an idle/errored teammate",
        "  team_approve_plan — Approve a teammate's plan (if plan mode)",
        "  team_shutdown     — Gracefully stop a teammate",
        "  team_cleanup      — Remove team resources (after all shutdown)",
        "",
        "Lifecycle: spawn → work → shutdown → cleanup (auto if all shutdown)",
        params.tasks?.length ? `\nInitial tasks: ${params.tasks.length}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { teamName: params.name, delegate: !!params.delegate },
    }
  },
})

/**
 * Spawn a new teammate — creates a child session and starts its prompt loop.
 */
export const TeamSpawnTool = Tool.define("team_spawn", {
  description:
    "Spawn a new teammate for the current team. Each teammate runs in its own session " +
    "with its own context window. Specify the agent type, a name, and a prompt describing " +
    "what this teammate should work on. You can optionally assign a different model to each " +
    "teammate (e.g. use Gemini for research and Claude for implementation). " +
    "SUBAGENT RELAY: If subagents are used, they CANNOT communicate with the team directly; " +
    "teammates are responsible for relaying any relevant findings.",
  parameters: z.object({
    name: MemberNameSchema.describe("Unique name for this teammate, e.g. 'security-reviewer', 'frontend-impl'"),
    agent: z.string().optional().describe("Agent type to use (e.g. 'explore', 'general'). Defaults to 'general'."),
    model: z
      .string()
      .optional()
      .describe(
        "Model to use for this teammate in 'provider/model' format, e.g. 'anthropic/claude-sonnet-4-20250514', " +
          "'google/gemini-2.5-pro', 'openai/gpt-4.1'. Must be a model available in your configured providers " +
          "(the same models shown by /models). If omitted, inherits the agent's default or the lead's current model.",
      ),
    prompt: z.string().describe("Initial instructions for the teammate — what they should work on"),
    claim_task: z.string().optional().describe("Task ID to auto-claim for this teammate"),
    timeout: z
      .number()
      .optional()
      .describe("Maximum execution time in minutes. Teammate is auto-cancelled when exceeded. Default: no limit."),
    require_plan_approval: z
      .boolean()
      .optional()
      .describe(
        "If true, the teammate starts in read-only plan mode. " +
          "They can read/search but cannot write/edit/bash until the lead approves their plan. " +
          "The teammate should research, then send their plan to the lead via team_message. " +
          "The lead can then use team_approve_plan to grant write access.",
      ),
  }),
  async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, any> }> {
    // Reserve "lead" — it's used as a routing keyword in messaging
    if (params.name === "lead") {
      return {
        title: "Error",
        output: `Name "lead" is reserved. Choose a different name for this teammate.`,
        metadata: {},
      }
    }

    // Constraint: only the lead can spawn — teammates cannot spawn (no nesting)
    const teamInfo = await Team.findBySession(ctx.sessionID)
    if (!teamInfo) {
      return {
        title: "Error",
        output: "You are not the lead of any team. Create a team first with team_create.",
        metadata: {},
      }
    }
    if (teamInfo.role === "member") {
      return {
        title: "Error",
        output: "Teammates cannot spawn other teammates. Only the team lead can spawn new members.",
        metadata: {},
      }
    }
    const teamName = teamInfo.team.name

    // Resolve agent
    const agentName = params.agent ?? "general"
    const agent = await Agent.get(agentName)
    if (!agent) {
      return {
        title: "Error",
        output: `Agent "${agentName}" not found. Available agents: ${(await Agent.list()).map((a) => a.name).join(", ")}`,
        metadata: {},
      }
    }

    // Resolve the model for this teammate early — fail fast before creating session.
    // Priority: explicit params.model > agent.model > lead's current model > default
    const model = await (async () => {
      // 1. Explicit model param — parse and validate against configured providers
      if (params.model) {
        const parsed = Provider.parseModel(params.model)
        try {
          await Provider.getModel(parsed.providerID, parsed.modelID)
        } catch (e: unknown) {
          if (Provider.ModelNotFoundError.isInstance(e)) {
            const suggestions = e.data.suggestions?.length ? ` Did you mean: ${e.data.suggestions.join(", ")}?` : ""
            return { error: `Model not found: ${params.model}.${suggestions}` } as const
          }
          throw e
        }
        return parsed
      }
      // 2. Agent's configured model
      if (agent.model) return agent.model
      // 3. Lead's current model (from the last user message in the lead's session)
      const lastUser = ctx.messages.findLast((m) => m.info.role === "user")
      if (lastUser) {
        const info = lastUser.info as { model: { providerID: string; modelID: string } }
        return info.model
      }
      // 4. Global default model
      return await Provider.defaultModel()
    })()

    // Bail out if model resolution failed
    if ("error" in model) {
      return {
        title: "Error",
        output: model.error,
        metadata: {},
      }
    }

    const spawned = await Team.spawnMember({
      teamName,
      name: params.name,
      parentSessionID: ctx.sessionID,
      agent,
      model,
      prompt: params.prompt,
      claimTask: params.claim_task,
      planApproval: !!params.require_plan_approval,
      timeout: params.timeout,
    })

    return {
      title: `Spawned teammate: ${params.name}`,
      output: [
        `Teammate "${params.name}" spawned with agent "${agentName}" using model ${spawned.label}.`,
        `Session ID: ${spawned.sessionID}`,
        params.claim_task ? `Auto-claimed task: ${params.claim_task}` : "",
        params.require_plan_approval
          ? "Plan approval REQUIRED: teammate is in read-only mode until you approve their plan with team_approve_plan."
          : "",
        "",
        "The teammate is now working independently in the background.",
        "Messages from the teammate will be delivered automatically when they finish or need help.",
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: {
        teamName,
        memberName: params.name,
        sessionID: spawned.sessionID,
        model: spawned.label,
        planApproval: params.require_plan_approval,
      },
    }
  },
})

/**
 * Send a message to a specific teammate or the lead.
 */
export const TeamMessageTool = Tool.define("team_message", {
  description:
    "Send a message to a specific teammate or the team lead. " +
    "Use this to share findings, ask questions, or coordinate work. " +
    "Note: task subagents cannot use this tool — only teammates and the lead.",
  parameters: z.object({
    to: z.string().describe("Name of the recipient teammate, or 'lead' to message the team lead"),
    text: z.string().describe("The message content"),
  }),
  async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, any> }> {
    const teamInfo = await Team.findBySession(ctx.sessionID)
    if (!teamInfo) {
      return {
        title: "Error",
        output: "You are not part of any team.",
        metadata: {},
      }
    }

    const fromName = teamInfo.role === "lead" ? "lead" : teamInfo.memberName!

    await TeamMessaging.send({
      teamName: teamInfo.team.name,
      from: fromName,
      to: params.to,
      text: params.text,
    })

    return {
      title: `Message sent to ${params.to}`,
      output: `Message delivered to "${params.to}".`,
      metadata: { to: params.to },
    }
  },
})

/**
 * Broadcast a message to all teammates.
 */
export const TeamBroadcastTool = Tool.define("team_broadcast", {
  description:
    "Send a message to all teammates simultaneously. Use sparingly — " +
    "prefer targeted messages. Good for announcements or shared context updates.",
  parameters: z.object({
    text: z.string().describe("The message to broadcast to all teammates"),
  }),
  async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, any> }> {
    const teamInfo = await Team.findBySession(ctx.sessionID)
    if (!teamInfo) {
      return {
        title: "Error",
        output: "You are not part of any team.",
        metadata: {},
      }
    }

    const fromName = teamInfo.role === "lead" ? "lead" : teamInfo.memberName!

    await TeamMessaging.broadcast({
      teamName: teamInfo.team.name,
      from: fromName,
      text: params.text,
    })

    return {
      title: "Broadcast sent",
      output: `Broadcast sent to all teammates in "${teamInfo.team.name}".`,
      metadata: {},
    }
  },
})

/**
 * View or update the shared task list.
 */
export const TeamTasksTool = Tool.define("team_tasks", {
  description:
    "View or update the shared task list for the team. " +
    "Use action 'list' to see all tasks, 'add' to add new tasks, " +
    "'complete' to mark a task done, or 'update' to replace the full list.",
  parameters: z.object({
    action: z.enum(["list", "add", "complete", "update"]).describe("What to do with the task list"),
    tasks: z
      .array(
        z.object({
          id: z.string(),
          content: z.string(),
          status: z.enum(["pending", "in_progress", "completed", "cancelled", "blocked"]),
          priority: z.enum(["high", "medium", "low"]),
          assignee: z.string().optional(),
          depends_on: z.array(z.string()).optional(),
        }),
      )
      .optional()
      .describe("Tasks to add or the full replacement list (for 'add' and 'update' actions)"),
    task_id: z.string().optional().describe("Task ID to complete (for 'complete' action)"),
  }),
  async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, any> }> {
    const teamInfo = await Team.findBySession(ctx.sessionID)
    if (!teamInfo) {
      return { title: "Error", output: "You are not part of any team.", metadata: {} }
    }
    const teamName = teamInfo.team.name

    switch (params.action) {
      case "list": {
        const tasks = await TeamTasks.list(teamName)
        if (tasks.length === 0) {
          return { title: "Task list", output: "No tasks in the team task list.", metadata: {} }
        }
        const output = tasks
          .map((t) => {
            const status = t.status === "in_progress" ? `in_progress (${t.assignee ?? "?"})` : t.status
            const deps = t.depends_on?.length ? ` [deps: ${t.depends_on.join(", ")}]` : ""
            return `[${t.id}] ${t.content} — ${status} (${t.priority})${deps}`
          })
          .join("\n")
        return { title: "Task list", output, metadata: { count: tasks.length } }
      }
      case "add": {
        if (!params.tasks?.length) {
          return { title: "Error", output: "No tasks provided to add.", metadata: {} }
        }
        const newTasks: TeamTask[] = params.tasks.map((t) => ({ ...t, status: "pending" as const }))
        await TeamTasks.add(teamName, newTasks)
        return {
          title: `Added ${params.tasks.length} tasks`,
          output: `Added ${params.tasks.length} task(s) to the shared list.`,
          metadata: {},
        }
      }
      case "complete": {
        if (!params.task_id) {
          return { title: "Error", output: "No task_id provided.", metadata: {} }
        }
        await TeamTasks.complete(teamName, params.task_id)
        return {
          title: `Completed task ${params.task_id}`,
          output: `Task "${params.task_id}" marked as completed. Dependent tasks may have been unblocked.`,
          metadata: {},
        }
      }
      case "update": {
        if (!params.tasks) {
          return { title: "Error", output: "No tasks provided for update.", metadata: {} }
        }
        await TeamTasks.update(teamName, params.tasks as TeamTask[])
        return {
          title: "Task list updated",
          output: `Replaced task list with ${params.tasks.length} task(s).`,
          metadata: {},
        }
      }
    }
  },
})

/**
 * Claim a pending task from the shared task list.
 */
export const TeamClaimTool = Tool.define("team_claim", {
  description:
    "Claim a pending task from the team's shared task list. " +
    "Only pending, unassigned tasks with resolved dependencies can be claimed. " +
    "Uses file locking to prevent race conditions.",
  parameters: z.object({
    task_id: z.string().describe("The ID of the task to claim"),
  }),
  async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, any> }> {
    const teamInfo = await Team.findBySession(ctx.sessionID)
    if (!teamInfo) {
      return { title: "Error", output: "You are not part of any team.", metadata: {} }
    }

    const memberName = teamInfo.role === "lead" ? "lead" : teamInfo.memberName!
    const claimed = await TeamTasks.claim(teamInfo.team.name, params.task_id, memberName)

    if (claimed) {
      return {
        title: `Claimed task ${params.task_id}`,
        output: `You claimed task "${params.task_id}". It's now in_progress assigned to you.`,
        metadata: { taskId: params.task_id },
      }
    } else {
      return {
        title: "Claim failed",
        output: `Could not claim task "${params.task_id}". It may already be taken, blocked, or not found.`,
        metadata: {},
      }
    }
  },
})

/**
 * Approve or reject a teammate's plan — lifts write restrictions on approval.
 */
export const TeamApprovePlanTool = Tool.define("team_approve_plan", {
  description:
    "Approve or reject a teammate's implementation plan. When a teammate is spawned with " +
    "require_plan_approval=true, they start in read-only mode and must submit a plan. " +
    "Use this tool to approve (unlocks write tools) or reject (teammate revises their plan).",
  parameters: z.object({
    name: MemberNameSchema.describe("Name of the teammate whose plan to review"),
    approved: z.boolean().describe("true to approve the plan and unlock write access, false to reject"),
    feedback: z.string().optional().describe("Feedback for the teammate — required on rejection, optional on approval"),
  }),
  async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, any> }> {
    const teamInfo = await Team.findBySession(ctx.sessionID)
    if (!teamInfo || teamInfo.role !== "lead") {
      return { title: "Error", output: "Only the team lead can approve plans.", metadata: {} }
    }

    const member = teamInfo.team.members.find((m) => m.name === params.name)
    if (!member) {
      return { title: "Error", output: `Teammate "${params.name}" not found.`, metadata: {} }
    }
    if (member.planApproval !== "pending" && member.planApproval !== "rejected") {
      return {
        title: "Error",
        output: `Teammate "${params.name}" is not awaiting plan approval (current: ${member.planApproval ?? "none"}).`,
        metadata: {},
      }
    }

    if (params.approved) {
      // Remove only plan-approval deny rules (tagged with "*:plan-approval" pattern)
      const { SessionID } = await import("../session/schema")
      const sid = SessionID.make(member.sessionID)
      const session = await Session.get(sid)
      if (session.permission) {
        await Session.setPermission({
          sessionID: sid,
          permission: session.permission.filter((rule: { pattern: string }) => rule.pattern !== "*:plan-approval"),
        })
      }

      // Update member state
      await Team.setMemberPlanApproval(teamInfo.team.name, params.name, "approved")

      // Notify the teammate
      await TeamMessaging.send({
        teamName: teamInfo.team.name,
        from: "lead",
        to: params.name,
        text: params.feedback
          ? `Your plan has been APPROVED. You now have full write access. Feedback: ${params.feedback}`
          : "Your plan has been APPROVED. You now have full write access. Proceed with implementation.",
      })

      await Bus.publish(TeamEvent.PlanApproval, {
        teamName: teamInfo.team.name,
        memberName: params.name,
        approved: true,
        feedback: params.feedback,
      })

      return {
        title: `Plan approved: ${params.name}`,
        output: `Approved "${params.name}"'s plan. Write tools are now unlocked for this teammate.`,
        metadata: { approved: true },
      }
    } else {
      // Rejected — keep read-only mode, mark as rejected.
      // The teammate's next plan submission resets to "pending".
      await Team.setMemberPlanApproval(teamInfo.team.name, params.name, "rejected")

      await TeamMessaging.send({
        teamName: teamInfo.team.name,
        from: "lead",
        to: params.name,
        text: `Your plan has been REJECTED. Please revise and resubmit. Feedback: ${params.feedback ?? "No specific feedback provided."}`,
      })

      await Bus.publish(TeamEvent.PlanApproval, {
        teamName: teamInfo.team.name,
        memberName: params.name,
        approved: false,
        feedback: params.feedback,
      })

      return {
        title: `Plan rejected: ${params.name}`,
        output: `Rejected "${params.name}"'s plan. They remain in read-only mode and should revise.`,
        metadata: { approved: false },
      }
    }
  },
})

/**
 * Request a teammate to shut down. The teammate can approve or reject.
 */
export const TeamShutdownTool = Tool.define("team_shutdown", {
  description:
    "Request a teammate to shut down gracefully. The teammate receives the shutdown request " +
    "and can wrap up current work before exiting. Shutdown is authoritative — once requested, " +
    "the teammate will be transitioned to shutdown after processing the message. " +
    "Only the team lead should use this.",
  parameters: z.object({
    name: MemberNameSchema.describe("Name of the teammate to shut down"),
    reason: z.string().optional().describe("Reason for the shutdown request"),
  }),
  async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, any> }> {
    const teamInfo = await Team.findBySession(ctx.sessionID)
    if (!teamInfo || teamInfo.role !== "lead") {
      return { title: "Error", output: "Only the team lead can shut down teammates.", metadata: {} }
    }

    const member = teamInfo.team.members.find((m) => m.name === params.name)
    if (!member) {
      return {
        title: "Error",
        output: `Teammate "${params.name}" not found.`,
        metadata: {},
      }
    }
    if (member.status === "shutdown") {
      return {
        title: "Already shutdown",
        output: `Teammate "${params.name}" is already shut down.`,
        metadata: {},
      }
    }

    const reason = params.reason ?? "The lead has requested you shut down."

    // Transition to shutdown_requested BEFORE sending the message.
    // This ensures autoWake's .then() handler sees the correct status
    // when the auto-woken loop completes.
    await Team.transitionMemberStatus(teamInfo.team.name, params.name, "shutdown_requested")

    await Bus.publish(TeamEvent.ShutdownRequest, {
      teamName: teamInfo.team.name,
      memberName: params.name,
    })

    // Send the shutdown message — this triggers autoWake which starts
    // a new prompt loop. When that loop ends, the .then() handler
    // sees shutdown_requested and transitions to shutdown.
    // If the send fails, fall back to direct shutdown since there's
    // no loop that will trigger the transition.
    try {
      await TeamMessaging.send({
        teamName: teamInfo.team.name,
        from: "lead",
        to: params.name,
        text: [
          `SHUTDOWN REQUEST: ${reason}`,
          "",
          "Please wrap up your current work:",
          "1. Summarize your findings and send them to the lead.",
          "2. Stop working after sending your summary.",
        ].join("\n"),
      })
    } catch {
      await Team.transitionMemberStatus(teamInfo.team.name, params.name, "shutdown")
    }

    if (member.status === "busy") {
      await Team.cancelMember(teamInfo.team.name, params.name)
    }

    return {
      title: `Shutdown requested: ${params.name}`,
      output: `Shutdown request sent to "${params.name}". They will wrap up current work and stop.`,
      metadata: {},
    }
  },
})

/**
 * Clean up the team — remove config and task files.
 */
export const TeamCleanupTool = Tool.define("team_cleanup", {
  description:
    "Clean up the team by removing all team resources (config, task list). " +
    "All teammates must be shut down first. Only the lead should call this.",
  parameters: z.object({
    name: TeamNameSchema.describe("Team name to clean up"),
  }),
  async execute(params, ctx) {
    // Authorization: only the lead of this specific team can clean it up
    const teamInfo = await Team.findBySession(ctx.sessionID)
    if (!teamInfo || teamInfo.role !== "lead" || teamInfo.team.name !== params.name) {
      return {
        title: "Error",
        output: "Only the lead of this team can clean it up.",
        metadata: {},
      }
    }

    try {
      const wasDelegate = teamInfo.team.delegate === true
      await Team.cleanup(params.name)
      return {
        title: `Team cleaned up: ${params.name}`,
        output: [
          `Team "${params.name}" has been cleaned up. All resources removed.`,
          wasDelegate ? "Delegate mode restrictions have been removed. You can now use all tools again." : "",
        ]
          .filter(Boolean)
          .join("\n"),
        metadata: {},
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        title: "Cleanup failed",
        output: `Failed to clean up team: ${msg}`,
        metadata: {},
      }
    }
  },
})

/**
 * Health check — diagnose stuck teammates, blocked tasks, and undelivered messages.
 */
export const TeamHealthTool = Tool.define("team_health", {
  description:
    "Diagnose team health issues: stuck teammates (busy too long), blocked tasks " +
    "with unresolvable dependencies, and undelivered inbox messages. Use this when " +
    "the team seems stuck or you suspect something is wrong.",
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

    const { Inbox } = await import("../team/inbox")
    const { activeConflicts } = await import("../team/files")
    const tasks = await TeamTasks.list(team.name)
    const now = Date.now()
    const issues: string[] = []

    // Check for stuck teammates (busy > 10 minutes with no status change)
    for (const m of team.members) {
      if (m.status === "busy") {
        const elapsed = Math.round((now - (m.started ?? m.updated ?? team.created)) / 60000)
        if (elapsed > 10) {
          issues.push(`STUCK: "${m.name}" has been busy for ${elapsed} minutes`)
        }
      }
      if (m.status === "error") {
        issues.push(`ERROR: "${m.name}" is in error state — consider restarting or shutting down`)
      }
    }

    // Check for blocked tasks with no path to unblock
    const blocked = tasks.filter((t) => t.status === "blocked")
    for (const t of blocked) {
      const deps = t.depends_on ?? []
      const unresolvable = deps.filter((dep) => {
        const d = tasks.find((x) => x.id === dep)
        return !d || d.status === "cancelled"
      })
      if (unresolvable.length > 0) {
        issues.push(`BLOCKED: Task "${t.id}" depends on missing/cancelled tasks: ${unresolvable.join(", ")}`)
      }
    }

    // Check for undelivered messages
    for (const m of team.members) {
      const unread = await Inbox.unread(team.name, m.name).catch(() => [])
      if (unread.length > 5) {
        issues.push(`BACKLOG: "${m.name}" has ${unread.length} unread messages`)
      }
    }
    const leadUnread = await Inbox.unread(team.name, "lead").catch(() => [])
    if (leadUnread.length > 5) {
      issues.push(`BACKLOG: Lead has ${leadUnread.length} unread messages`)
    }

    // Check for file conflicts
    const conflicts = activeConflicts(team.name)
    for (const c of conflicts) {
      issues.push(`CONFLICT: ${c.file} edited by: ${c.members.join(", ")}`)
    }

    if (issues.length === 0) {
      return { title: "Team health", output: "No issues detected. Team is healthy.", metadata: {} }
    }

    return {
      title: `Team health: ${issues.length} issues`,
      output: issues.join("\n"),
      metadata: { issues: issues.length },
    }
  },
})

/**
 * Restart an idle/errored teammate by re-engaging their prompt loop.
 */
export const TeamRestartTool = Tool.define("team_restart", {
  description:
    "Restart an idle or errored teammate by sending them a new message and waking " +
    "their prompt loop. Cheaper than shutdown + re-spawn because it reuses the existing session.",
  parameters: z.object({
    name: z.string().describe("Name of the teammate to restart"),
    message: z.string().describe("Instructions for the restarted teammate — what they should do next"),
  }),
  async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, any> }> {
    const info = await Team.findBySession(ctx.sessionID)
    if (!info || info.role !== "lead") {
      return { title: "Error", output: "Only the team lead can restart teammates.", metadata: {} }
    }

    const team = await Team.get(info.team.name)
    if (!team) {
      return { title: "Error", output: `Team "${info.team.name}" not found.`, metadata: {} }
    }

    const member = team.members.find((m) => m.name === params.name)
    if (!member) {
      return { title: "Error", output: `Teammate "${params.name}" not found.`, metadata: {} }
    }

    if (member.status !== "ready" && member.status !== "error") {
      return {
        title: "Error",
        output: `Teammate "${params.name}" is ${member.status} — can only restart ready or errored teammates.`,
        metadata: {},
      }
    }

    await Team.restart({
      teamName: info.team.name,
      memberName: params.name,
      text: params.message,
    })

    return {
      title: `Restarted: ${params.name}`,
      output: `Sent new instructions to "${params.name}" and triggered auto-wake. They should begin processing shortly.`,
      metadata: {},
    }
  },
})

export const TeamTools = [
  TeamCreateTool,
  TeamSpawnTool,
  TeamMessageTool,
  TeamBroadcastTool,
  TeamTasksTool,
  TeamClaimTool,
  TeamApprovePlanTool,
  TeamShutdownTool,
  TeamCleanupTool,
  TeamStatusTool,
  TeamNotepadTool,
  TeamHealthTool,
  TeamRestartTool,
]

export const TEAM_TOOL_IDS = TeamTools.map((tool) => tool.id)
