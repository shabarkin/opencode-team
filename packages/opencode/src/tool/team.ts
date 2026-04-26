import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import {
  Team,
  TeamTasks,
  addDelegateRules,
  type TeamTask,
} from "../team"
import { TeamMessaging } from "../team/messaging"
import { Session } from "../session"
import { Agent } from "../agent/agent"
import { Bus } from "../bus"
import { TeamEvent } from "../team/events"
import { Flag } from "../flag/flag"
import { TeamStatusTool } from "./team-status"
import { TeamNotepadTool } from "./team-notepad"
import { TeamDelegateTool } from "./team-delegate"
import { TeamCollectTool } from "./team-collect"
import { TeamInboxTool, TeamSubmitResultTool, TeamWaitTool } from "./team-inbox"
import { TeamPhaseTool, TeamShutdownAllTool } from "./team-lifecycle"
import { SessionID } from "../session/schema"
import { Inbox } from "../team/inbox"
import { activeConflicts } from "../team/files"
import { Bounded, SafeName } from "./team-schema"

const MESSAGE_TYPE_VALUES = [
  "message",
  "question",
  "status",
  "plan",
  "error",
  "result",
  "system",
  "spawn_request",
] as const
const MESSAGE_PRIORITY_VALUES = ["normal", "urgent", "low"] as const
const OUTPUT_FORMAT_VALUES = ["free", "single_synthesis", "structured_report"] as const
const TEAM_MODE_VALUES = ["research", "implementation", "mixed"] as const
const CHECKPOINT_MODE_VALUES = ["none", "after_each_write", "after_each_tool"] as const
const TASK_PRIORITY_VALUES = ["high", "medium", "low"] as const
const TASK_STATUS_VALUES = ["pending", "in_progress", "completed", "cancelled", "blocked"] as const
const TASKS_ACTION_VALUES = ["list", "add", "complete", "update"] as const
const MERGE_ACTION_VALUES = ["merge", "continue", "abort", "mark_resolved"] as const

/**
 * Create a new agent team. Only the lead session should call this.
 */
export const TeamCreateParameters = Schema.Struct({
  name: SafeName.annotate({ description: "Team name — lowercase, hyphens allowed. E.g. 'auth-review', 'feature-impl'" }),
  tasks: Schema.optional(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          id: Schema.String,
          content: Schema.String,
          priority: Schema.Literals(TASK_PRIORITY_VALUES),
          depends_on: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
        }),
      ),
    ),
  ).annotate({ description: "Optional initial task list for the team" }),
  delegate: Schema.optional(Schema.Boolean).annotate({
    description:
      "If true, enables delegate mode: the lead is restricted to coordination-only tools " +
      "(team_*, read, glob, grep, list). The lead cannot write, edit, or run bash commands. " +
      "Use this when you want the lead to focus entirely on orchestration.",
  }),
  receipts: Schema.optional(Schema.Boolean).annotate({
    description: "If true, send low-priority read receipts when teammates read inbox messages.",
  }),
  collect_strict: Schema.optional(Schema.Boolean).annotate({
    description:
      "If true, team_collect requires fresh structured results by default before a member counts as collected.",
  }),
  require_result_before_shutdown: Schema.optional(Schema.Boolean).annotate({
    description:
      "If true, shutdown is blocked for teammates with in-progress assigned tasks until they submit a result.",
  }),
  output_format: Schema.optional(Schema.Literals(OUTPUT_FORMAT_VALUES)).annotate({
    description: "Optional final lead output shape. Use 'single_synthesis' to force one concise narrative synthesis.",
  }),
})

type TeamCreateMetadata = {
  teamName?: string
  delegate?: boolean
  collectStrict?: boolean
  requireResultBeforeShutdown?: boolean
  worktrees?: boolean
}

export const TeamCreateTool = Tool.define<typeof TeamCreateParameters, TeamCreateMetadata, Session.Service>(
  "team_create",
  Effect.gen(function* () {
    const sessions = yield* Session.Service

    return {
      description:
        "Create a new agent team for coordinating parallel work across multiple sessions. " +
        "Use this when the user explicitly asks for a team of agents, teammates, or delegate mode. " +
        "While the team is active, you become the team lead, which means your primary job is orchestration: break the goal into tasks, " +
        "spawn specialists, steer them with team_message or team_broadcast, monitor progress with team_status or team_inbox, " +
        "and synthesize only after team_collect. The lead may read or search strategically for planning and verification, " +
        "but should not become the main hands-on investigator or implementer.",
      parameters: TeamCreateParameters,
      execute: (params: Schema.Schema.Type<typeof TeamCreateParameters>, ctx: Tool.Context<TeamCreateMetadata>) =>
        Effect.gen(function* () {
          // Constraint: no nested teams — teammates cannot create teams
          const existingTeam = yield* Effect.promise(() => Team.findBySession(ctx.sessionID))
          if (existingTeam && existingTeam.role === "member") {
            return {
              title: "Error",
              output:
                "Teammates cannot create new teams. Only the lead session or an independent session can create a team.",
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

          const team = yield* Effect.promise(() =>
            Team.create({
              name: params.name,
              leadSessionID: ctx.sessionID,
              delegate: params.delegate,
              collect_strict: params.collect_strict,
              require_result_before_shutdown: params.require_result_before_shutdown,
              receipts: params.receipts,
              worktrees: Flag.OPENCODE_EXPERIMENTAL_AGENT_TEAMS_WORKTREES,
              output_format: params.output_format,
              team_phase: "spawning",
              delivered: false,
            }),
          )

          if (params.tasks?.length) {
            const tasks: TeamTask[] = params.tasks.map((t) => ({
              ...t,
              depends_on: t.depends_on ? [...t.depends_on] : undefined,
              status: "pending" as const,
            }))
            yield* Effect.promise(() => TeamTasks.add(params.name, tasks))
          }

          // Delegate mode: restrict the lead to coordination-only tools
          if (params.delegate) {
            const session = yield* sessions.get(ctx.sessionID)
            yield* sessions.setPermission({
              sessionID: ctx.sessionID,
              permission: addDelegateRules(session.permission ?? []),
            })
          }

          return {
            title: `Created team: ${params.name}`,
            output: [
              `Team "${params.name}" created. You are the lead.`,
              params.delegate
                ? "DELEGATE MODE: You are restricted to coordination tools only (no write/edit/bash)."
                : "",
              params.collect_strict
                ? "Strict collection enabled: team_collect now requires fresh structured results by default."
                : "",
              params.require_result_before_shutdown
                ? "Shutdown guard enabled: teammates with in-progress tasks must submit a result before shutdown."
                : "",
              team.worktrees
                ? "WORKTREES MODE: teammates get isolated git worktrees. Use team_merge to merge, continue, abort, or mark resolved before team_cleanup."
                : "",
              "",
              "LEAD ROLE (while this team is active):",
              "- Own the goal, task breakdown, delegation, pacing, and final synthesis",
              "- Keep teammates doing the hands-on investigation and implementation work",
              "- Use read/search only for strategic planning, validation, and integration decisions",
              "- Do NOT become the main executor while teammates are available to do the work",
              "",
              "Quick reference:",
              "  team_spawn        — Add a teammate (set agent, model, prompt, timeout)",
              "  team_status       — Full team snapshot (members, tasks, costs)",
              "  team_message      — Direct message a teammate (to: 'name')",
              "  team_reply        — Reply to the latest team message with thread context",
              "  team_broadcast    — Message all teammates",
              "  team_delegate     — Run a lightweight delegated subagent",
              "  team_inbox        — Read inbox state or flush undelivered messages",
              "  team_submit_result — Submit a structured result to the lead",
              "  team_wait         — Check whether a team condition is already met",
              "  team_collect      — Wait for teammate results before synthesis",
              "  team_tasks        — View/add/complete shared tasks",
              "  team_claim        — Claim a pending task",
              "  team_notepad      — Read/write shared team knowledge",
              "  team_phase        — Report a teammate work phase",
              "  team_health       — Diagnose stuck members, blocked tasks",
              "  team_restart      — Re-engage an idle/errored teammate",
              "  team_approve_plan — Approve a teammate's plan (if plan mode)",
              "  team_shutdown_all — Request shutdown for every active teammate",
              "  team_shutdown     — Gracefully stop a teammate",
              "  team_merge        — Merge worktrees or continue/abort/mark a conflict resolved",
              "  team_cleanup      — Remove team resources (after merge + shutdown)",
              "",
              "CRITICAL WORKFLOW:",
              "1. Break the goal into workstreams and capture them in team_tasks",
              "2. Spawn teammates to own those workstreams and keep yourself in an orchestration role",
              "3. Use team_status, team_inbox, team_message, and team_broadcast to steer the team",
              "4. Facilitate peer-to-peer interaction so teammates compare notes, help each other, and converge on a shared conclusion",
              "5. Use team_collect to WAIT for teammate results instead of doing their work yourself",
              "6. Do NOT produce final output while any teammate is still working or mid-review",
              "7. Only shut teammates down after reviews are complete, or if repeated error/noise is overwhelming the channel",
              "8. Deliver ONE consolidated synthesis, then shut down the team",
              team.worktrees
                ? "9. For worktree teams: team_merge (merge/continue/abort/mark_resolved) → verify/tests → team_cleanup"
                : "",
              "",
              "DELIVERY DISCIPLINE:",
              "- Produce ONE consolidated synthesis after team_collect returns",
              "- Prefer delegation, steering, consensus-building, and result collection over direct execution by the lead",
              "- Do NOT rush teammates who are mid-way through a review or implementation pass",
              "- Do NOT re-send summaries or repeatedly offer next steps",
              team.worktrees
                ? "- After delivery in worktree mode: team_shutdown_all → team_merge → verify → team_cleanup → done"
                : "- After delivery: team_shutdown_all → team_cleanup → done",
              params.output_format === "single_synthesis"
                ? "OUTPUT FORMAT: Produce one concise narrative synthesis. No matrices, scorecards, or checklists."
                : "",
              "",
              team.worktrees
                ? "Lifecycle: spawn → work → shutdown → team_merge → resolve/continue if needed → verify → cleanup"
                : "Lifecycle: spawn → work → shutdown → cleanup (auto if all shutdown)",
              params.tasks?.length ? `\nInitial tasks: ${params.tasks.length}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
            metadata: {
              teamName: params.name,
              delegate: !!params.delegate,
              collectStrict: !!params.collect_strict,
              requireResultBeforeShutdown: !!params.require_result_before_shutdown,
              worktrees: team.worktrees === true,
            },
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof TeamCreateParameters, TeamCreateMetadata>
  }),
)

/**
 * Spawn a new teammate — creates a child session and starts its prompt loop.
 */
export const TeamSpawnParameters = Schema.Struct({
  name: Schema.optional(SafeName).annotate({
    description: "Unique name for this teammate, e.g. 'security-reviewer', 'frontend-impl'",
  }),
  agent: Schema.optional(Schema.String).annotate({
    description: "Exact agent name to use. Defaults to 'general'.",
  }),
  model: Schema.optional(Schema.String).annotate({
    description:
      "Model to use for this teammate in 'provider/model' format, e.g. 'anthropic/claude-sonnet-4-20250514', " +
      "'google/gemini-2.5-pro', 'openai/gpt-4.1'. Must be a model available in your configured providers " +
      "(the same models shown by /models). If omitted, inherits the agent's default or the lead's current model.",
  }),
  prompt: Schema.optional(Schema.String).annotate({
    description: "Initial instructions for the teammate — what they should work on",
  }),
  claim_task: Schema.optional(Schema.String).annotate({
    description: "Task ID to auto-claim for this teammate",
  }),
  from_request: Schema.optional(Schema.String).annotate({
    description: "Approve or reject a pending spawn request by ID",
  }),
  reject_reason: Schema.optional(Schema.String).annotate({
    description: "If set with from_request, rejects that spawn request with this reason",
  }),
  timeout: Schema.optional(Bounded(1, 1440)).annotate({
    description:
      "Maximum execution time in minutes (1..1440). Teammate is auto-cancelled when exceeded. Default: no limit.",
  }),
  require_plan_approval: Schema.optional(Schema.Boolean).annotate({
    description:
      "If true, the teammate starts in read-only plan mode. " +
      "They can read/search but cannot write/edit/bash until the lead approves their plan. " +
      "The teammate should research, then send their plan to the lead via team_message. " +
      "The lead can then use team_approve_plan to grant write access.",
  }),
  mode: Schema.optional(Schema.Literals(TEAM_MODE_VALUES)).annotate({
    description:
      "'research' = read-only (no write/edit/bash). 'implementation' = full access. Default: 'mixed'.",
  }),
  result_deadline: Schema.optional(Bounded(1, 1440)).annotate({
    description:
      "Optional result deadline in minutes (1..1440). The teammate and lead are warned if no result arrives in time.",
  }),
  checkpoint: Schema.optional(Schema.Literals(CHECKPOINT_MODE_VALUES)).annotate({
    description:
      "Optional checkpoint mode. Use 'after_each_write' to pause after write/edit/bash/apply_patch, " +
      "'after_each_tool' to pause after every tool call, or 'none' to disable checkpoints.",
  }),
  path_excludes: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Optional glob patterns this teammate must not touch",
  }),
  path_includes: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Optional glob patterns this teammate is limited to",
  }),
  bash_allowlist: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Optional bash command patterns this teammate may run",
  }),
})

type TeamSpawnMetadata = {
  teamName?: string
  memberName?: string
  sessionId?: string
  model?: string
  planApproval?: boolean
  checkpoint?: string
  requestID?: string
  rejected?: boolean
}

export const TeamSpawnTool = Tool.define<typeof TeamSpawnParameters, TeamSpawnMetadata, Agent.Service>(
  "team_spawn",
  Effect.gen(function* () {
    const agent = yield* Agent.Service

    // Note: legacy code listed `Available agent types: ...` here from
    // Agent.list(), but Tool.define's init runs at AppRuntime layer build
    // (process-global, no Instance), and Agent.list reads per-instance state.
    // The agent name is validated in execute and the error message lists names.

    return {
      description:
        "Spawn a new teammate for the current team. Each teammate runs in its own session " +
        "with its own context window. Specify the agent type, a name, and a prompt describing " +
        "what this teammate should work on. You can optionally assign a different model to each " +
        "teammate (e.g. use Gemini for research and Claude for implementation). " +
        "As the lead, stay focused on orchestration after spawning: assign work, steer, unblock, monitor, and collect results rather than taking the task back yourself. " +
        "Use the exact configured agent name. " +
        "If the agent type is unknown, the tool errors with the available names. " +
        "SUBAGENT RELAY: If subagents are used, they CANNOT communicate with the team directly; " +
        "teammates are responsible for relaying any relevant findings.",
      parameters: TeamSpawnParameters,
      execute: (params: Schema.Schema.Type<typeof TeamSpawnParameters>, ctx: Tool.Context<TeamSpawnMetadata>) =>
        Effect.gen(function* () {
          let requestedBy = "lead"

          // Reserve "lead" — it's used as a routing keyword in messaging
          if (params.name === "lead") {
            return {
              title: "Error",
              output: `Name "lead" is reserved. Choose a different name for this teammate.`,
              metadata: {},
            }
          }

          // Constraint: only the lead can spawn — teammates cannot spawn (no nesting)
          const teamInfo = yield* Effect.promise(() => Team.findBySession(ctx.sessionID))
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

          const request = params.from_request
            ? yield* Effect.promise(() => Team.getSpawnRequest(teamName, params.from_request!))
            : undefined
          if (params.from_request && !request) {
            return {
              title: "Error",
              output: `Spawn request "${params.from_request}" not found.`,
              metadata: {},
            }
          }
          if (request) requestedBy = request.requested_by

          if (request && params.reject_reason) {
            yield* Effect.promise(() =>
              Team.rejectSpawnRequest({
                teamName,
                requestID: request.id,
                reason: params.reject_reason!,
              }),
            )
            yield* Effect.promise(() =>
              TeamMessaging.send({
                teamName,
                from: "lead",
                to: request.requested_by,
                text: `Your spawn request (${request.id}) was rejected. Reason: ${params.reject_reason}`,
              }).catch(() => {}),
            )
            return {
              title: `Rejected spawn request: ${request.id}`,
              output: `Rejected spawn request "${request.id}" from "${request.requested_by}".`,
              metadata: { requestID: request.id, rejected: true },
            }
          }

          const name = params.name ?? request?.name
          const prompt = params.prompt ?? request?.prompt
          if (!name) {
            return { title: "Error", output: "No teammate name provided.", metadata: {} }
          }
          if (!prompt) {
            return { title: "Error", output: "No teammate prompt provided.", metadata: {} }
          }

          // Resolve agent
          const agentName = params.agent ?? request?.agent ?? "general"
          const resolvedAgent = yield* agent.get(agentName)
          if (!resolvedAgent || resolvedAgent.mode === "primary" || resolvedAgent.hidden === true) {
            const allAgents = yield* agent.list()
            const names = allAgents
              .filter((item) => item.mode !== "primary" && item.hidden !== true)
              .map((item) => item.name)
              .sort()
            return {
              title: "Error",
              output: `Agent "${agentName}" not found. Available agents: ${names.join(", ")}`,
              metadata: {},
            }
          }

          // Resolve the model for this teammate early — fail fast before creating session.
          // Priority: explicit params.model > agent.model > lead's current model > default
          const model = yield* Effect.promise(() =>
            Team.resolveModel({
              model: params.model,
              agent: resolvedAgent,
              messages: ctx.messages,
            }),
          )

          // Bail out if model resolution failed
          if ("error" in model) {
            return {
              title: "Error",
              output: model.error,
              metadata: {},
            }
          }

          const spawned = yield* Effect.promise(() =>
            Team.spawnMember({
              teamName,
              name,
              parentSessionID: ctx.sessionID,
              requestedBy,
              agent: resolvedAgent,
              model,
              prompt,
              claimTask: params.claim_task,
              planApproval: !!params.require_plan_approval,
              mode: params.mode ?? "mixed",
              checkpoint: params.checkpoint ?? "none",
              resultDeadline: params.result_deadline,
              timeout: params.timeout,
              scope:
                params.path_excludes || params.path_includes || params.bash_allowlist
                  ? {
                      path_excludes: params.path_excludes ? [...params.path_excludes] : undefined,
                      path_includes: params.path_includes ? [...params.path_includes] : undefined,
                      bash_allowlist: params.bash_allowlist ? [...params.bash_allowlist] : undefined,
                    }
                  : undefined,
            }),
          )

          if ((yield* Effect.promise(() => Team.get(teamName)))?.team_phase === "spawning") {
            yield* Effect.promise(() => Team.setTeamPhase(teamName, "discovery"))
          }

          if (request) {
            yield* Effect.promise(() => Team.removeSpawnRequest(teamName, request.id))
            yield* Effect.promise(() =>
              TeamMessaging.send({
                teamName,
                from: "lead",
                to: request.requested_by,
                text: `Your spawn request (${request.id}) was approved. Teammate "${name}" is now active in the team.`,
              }).catch(() => {}),
            )
          }

          return {
            title: `Spawned teammate: ${name}`,
            output: [
              `Teammate "${name}" spawned with agent "${agentName}" using model ${spawned.label}.`,
              `Session ID: ${spawned.sessionID}`,
              params.claim_task ? `Auto-claimed task: ${params.claim_task}` : "",
              params.require_plan_approval
                ? "Plan approval REQUIRED: teammate is in read-only mode until you approve their plan with team_approve_plan."
                : "",
              params.mode === "research" ? "Research mode enabled: this teammate is read-only." : "",
              (params.checkpoint ?? "none") !== "none"
                ? `Checkpoint mode enabled: ${params.checkpoint ?? "none"}.`
                : "",
              params.result_deadline ? `Result deadline: ${params.result_deadline} minute(s).` : "",
              "",
              "The teammate is now working in the background.",
              "Stay in LEAD MODE while this team is active: keep orchestrating, avoid taking this task back yourself,",
              "and use team_tasks, team_status, team_inbox, and team_message to steer execution.",
              "Facilitate teammate-to-teammate coordination when useful so they can compare findings, help each other, and reach consensus.",
              "After spawning the team, use team_collect to wait for their results before synthesizing.",
              "Do not rush shutdown while a teammate is still mid-review unless repeated error/noise is overwhelming the channel.",
              "Messages from the teammate will be delivered automatically when they finish or need help.",
            ]
              .filter(Boolean)
              .join("\n"),
            metadata: {
              teamName,
              memberName: name,
              sessionId: spawned.sessionID,
              model: spawned.label,
              planApproval: params.require_plan_approval,
              checkpoint: params.checkpoint ?? "none",
            },
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof TeamSpawnParameters, TeamSpawnMetadata>
  }),
)

export const TeamRequestSpawnParameters = Schema.Struct({
  agent: Schema.String.annotate({ description: "Exact agent name to request." }),
  name: Schema.optional(SafeName).annotate({ description: "Optional suggested teammate name" }),
  rationale: Schema.String.annotate({ description: "Why this teammate is needed" }),
  prompt: Schema.optional(Schema.String).annotate({ description: "Optional suggested prompt for the new teammate" }),
})

type TeamRequestSpawnMetadata = {
  requestID?: string
  sessionId?: string
  approved?: boolean
}

export const TeamRequestSpawnTool = Tool.define<
  typeof TeamRequestSpawnParameters,
  TeamRequestSpawnMetadata,
  Agent.Service
>(
  "team_request_spawn",
  Effect.gen(function* () {
    const agent = yield* Agent.Service

    // See TeamSpawnTool — Agent.list cannot run at Tool.define init time
    // because it needs Instance context. Defer to execute and surface the
    // available names in the unknown-agent error path instead.

    return {
      description:
        "Request that the team lead spawn a new teammate. Use this when you discover the team needs " +
        "additional specialization mid-task. The lead can approve or reject the request, and plugins can " +
        "auto-approve or auto-deny it.",
      parameters: TeamRequestSpawnParameters,
      execute: (
        params: Schema.Schema.Type<typeof TeamRequestSpawnParameters>,
        ctx: Tool.Context<TeamRequestSpawnMetadata>,
      ) =>
        Effect.gen(function* () {
          const teamInfo = yield* Effect.promise(() => Team.findBySession(ctx.sessionID))
          if (!teamInfo || teamInfo.role !== "member" || !teamInfo.memberName) {
            return {
              title: "Error",
              output: "Only teammates can request new spawns. The lead should use team_spawn directly.",
              metadata: {},
            }
          }

          const resolvedAgent = yield* agent.get(params.agent)
          if (!resolvedAgent || resolvedAgent.mode === "primary" || resolvedAgent.hidden === true) {
            const allAgents = yield* agent.list()
            const names = allAgents
              .filter((item) => item.mode !== "primary" && item.hidden !== true)
              .map((item) => item.name)
              .sort()
            return {
              title: "Error",
              output: `Agent "${params.agent}" not found. Available agents: ${names.join(", ")}`,
              metadata: {},
            }
          }

          const result = yield* Effect.promise(() =>
            Team.requestSpawn({
              teamName: teamInfo.team.name,
              requestedBy: teamInfo.memberName!,
              agent: params.agent,
              rationale: params.rationale,
              name: params.name,
              prompt: params.prompt,
              messages: ctx.messages,
            }),
          )

          if (result.status === "denied") {
            return {
              title: "Spawn request denied",
              output: result.reason ?? "The spawn request was denied by team policy.",
              metadata: {},
            }
          }

          if (result.status === "approved") {
            return {
              title: `Spawned teammate: ${result.request.name ?? params.name ?? params.agent}`,
              output: `Your spawn request was auto-approved. Teammate session ${result.sessionID} is now active using ${result.label}.`,
              metadata: { requestID: result.request.id, sessionId: result.sessionID, approved: true },
            }
          }

          yield* Effect.promise(() =>
            TeamMessaging.send({
              teamName: teamInfo.team.name,
              from: teamInfo.memberName!,
              to: "lead",
              text: `Spawn request ${result.request.id}: please add ${params.agent}${params.name ? ` as "${params.name}"` : ""}. Rationale: ${params.rationale}`,
              type: "spawn_request",
              priority: "normal",
              threadId: result.request.id,
              metadata: {
                requestID: result.request.id,
                agent: params.agent,
                name: params.name,
              },
            }).catch(() => {}),
          )

          return {
            title: `Spawn request submitted: ${result.request.id}`,
            output: `Requested a new teammate from the lead. Request ID: ${result.request.id}.`,
            metadata: { requestID: result.request.id },
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof TeamRequestSpawnParameters, TeamRequestSpawnMetadata>
  }),
)

/**
 * Send a message to a specific teammate or the lead.
 */
export const TeamMessageParameters = Schema.Struct({
  to: Schema.String.annotate({ description: "Name of the recipient teammate, or 'lead' to message the team lead" }),
  text: Schema.String.annotate({ description: "The message content" }),
  type: Schema.optional(Schema.Literals(MESSAGE_TYPE_VALUES)).annotate({
    description: "Optional message type: question, status, plan, error, result, system, or spawn_request.",
  }),
  priority: Schema.optional(Schema.Literals(MESSAGE_PRIORITY_VALUES)).annotate({
    description: "Optional priority. Use urgent for interruptions, low for background context.",
  }),
  thread_id: Schema.optional(Schema.String).annotate({ description: "Optional thread ID for related messages." }),
  reply_to: Schema.optional(Schema.String).annotate({
    description: "Optional inbox message ID this message replies to.",
  }),
})

type TeamMessageMetadata = {
  to?: string
  threadId?: string
  replyTo?: string
}

export const TeamMessageTool = Tool.define<typeof TeamMessageParameters, TeamMessageMetadata, never>(
  "team_message",
  Effect.gen(function* () {
    return {
      description:
        "Send a message to a specific teammate or the team lead. " +
        "Use this to share findings, ask questions, or coordinate work. " +
        "Note: task subagents cannot use this tool — only teammates and the lead.",
      parameters: TeamMessageParameters,
      execute: (params: Schema.Schema.Type<typeof TeamMessageParameters>, ctx: Tool.Context<TeamMessageMetadata>) =>
        Effect.gen(function* () {
          const teamInfo = yield* Effect.promise(() => Team.findBySession(ctx.sessionID))
          if (!teamInfo) {
            return {
              title: "Error",
              output: "You are not part of any team.",
              metadata: {},
            }
          }

          const fromName = teamInfo.role === "lead" ? "lead" : teamInfo.memberName!

          yield* Effect.promise(() =>
            TeamMessaging.send({
              teamName: teamInfo.team.name,
              from: fromName,
              to: params.to,
              text: params.text,
              type: params.type,
              priority: params.priority,
              threadId: params.thread_id,
              replyTo: params.reply_to,
            }),
          )

          return {
            title: `Message sent to ${params.to}`,
            output: `Message delivered to "${params.to}".`,
            metadata: { to: params.to, threadId: params.thread_id, replyTo: params.reply_to },
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof TeamMessageParameters, TeamMessageMetadata>
  }),
)

export const TeamReplyParameters = Schema.Struct({
  text: Schema.String.annotate({ description: "Reply content" }),
  type: Schema.optional(Schema.Literals(MESSAGE_TYPE_VALUES)).annotate({
    description: "Optional reply type such as result, question, or status.",
  }),
  priority: Schema.optional(Schema.Literals(MESSAGE_PRIORITY_VALUES)).annotate({
    description: "Optional reply priority.",
  }),
})

type TeamReplyMetadata = {
  to?: string
  threadId?: string
  replyTo?: string
}

export const TeamReplyTool = Tool.define<typeof TeamReplyParameters, TeamReplyMetadata, never>(
  "team_reply",
  Effect.gen(function* () {
    return {
      description:
        "Reply to the most recent non-receipt team message in your inbox. " +
        "This automatically fills in the recipient, thread ID, and reply target.",
      parameters: TeamReplyParameters,
      execute: (params: Schema.Schema.Type<typeof TeamReplyParameters>, ctx: Tool.Context<TeamReplyMetadata>) =>
        Effect.gen(function* () {
          const teamInfo = yield* Effect.promise(() => Team.findBySession(ctx.sessionID))
          if (!teamInfo) {
            return {
              title: "Error",
              output: "You are not part of any team.",
              metadata: {},
            }
          }

          const name = teamInfo.role === "lead" ? "lead" : teamInfo.memberName!
          const last = (yield* Effect.promise(() => Inbox.all(teamInfo.team.name, name)))
            .filter((item) => !item.text.startsWith("[receipt]"))
            .findLast(() => true)

          if (!last) {
            return {
              title: "Error",
              output: "No team message found to reply to.",
              metadata: {},
            }
          }

          yield* Effect.promise(() =>
            TeamMessaging.send({
              teamName: teamInfo.team.name,
              from: name,
              to: last.from,
              text: params.text,
              type: params.type,
              priority: params.priority,
              threadId: last.threadId ?? last.id,
              replyTo: last.id,
            }),
          )

          return {
            title: `Reply sent to ${last.from}`,
            output: `Reply delivered to "${last.from}" in thread "${last.threadId ?? last.id}".`,
            metadata: { to: last.from, threadId: last.threadId ?? last.id, replyTo: last.id },
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof TeamReplyParameters, TeamReplyMetadata>
  }),
)

/**
 * Broadcast a message to all teammates.
 */
export const TeamBroadcastParameters = Schema.Struct({
  text: Schema.String.annotate({ description: "The message to broadcast to all teammates" }),
  type: Schema.optional(Schema.Literals(MESSAGE_TYPE_VALUES)).annotate({
    description: "Optional broadcast type.",
  }),
  priority: Schema.optional(Schema.Literals(MESSAGE_PRIORITY_VALUES)).annotate({
    description: "Optional broadcast priority.",
  }),
  thread_id: Schema.optional(Schema.String).annotate({ description: "Optional thread ID for all broadcast copies." }),
})

type TeamBroadcastMetadata = Record<string, never>

export const TeamBroadcastTool = Tool.define<typeof TeamBroadcastParameters, TeamBroadcastMetadata, never>(
  "team_broadcast",
  Effect.gen(function* () {
    return {
      description:
        "Send a message to all teammates simultaneously. Use sparingly — " +
        "prefer targeted messages. Good for announcements or shared context updates.",
      parameters: TeamBroadcastParameters,
      execute: (
        params: Schema.Schema.Type<typeof TeamBroadcastParameters>,
        ctx: Tool.Context<TeamBroadcastMetadata>,
      ) =>
        Effect.gen(function* () {
          const teamInfo = yield* Effect.promise(() => Team.findBySession(ctx.sessionID))
          if (!teamInfo) {
            return {
              title: "Error",
              output: "You are not part of any team.",
              metadata: {},
            }
          }

          const fromName = teamInfo.role === "lead" ? "lead" : teamInfo.memberName!

          yield* Effect.promise(() =>
            TeamMessaging.broadcast({
              teamName: teamInfo.team.name,
              from: fromName,
              text: params.text,
              type: params.type,
              priority: params.priority,
              threadId: params.thread_id,
            }),
          )

          return {
            title: "Broadcast sent",
            output: `Broadcast sent to all teammates in "${teamInfo.team.name}".`,
            metadata: {},
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof TeamBroadcastParameters, TeamBroadcastMetadata>
  }),
)

/**
 * View or update the shared task list.
 */
export const TeamTasksParameters = Schema.Struct({
  action: Schema.Literals(TASKS_ACTION_VALUES).annotate({ description: "What to do with the task list" }),
  tasks: Schema.optional(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          id: Schema.String,
          content: Schema.String,
          status: Schema.Literals(TASK_STATUS_VALUES),
          priority: Schema.Literals(TASK_PRIORITY_VALUES),
          assignee: Schema.optional(Schema.String),
          depends_on: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
        }),
      ),
    ),
  ).annotate({ description: "Tasks to add or the full replacement list (for 'add' and 'update' actions)" }),
  task_id: Schema.optional(Schema.String).annotate({ description: "Task ID to complete (for 'complete' action)" }),
})

type TeamTasksMetadata = {
  count?: number
}

export const TeamTasksTool = Tool.define<typeof TeamTasksParameters, TeamTasksMetadata, never>(
  "team_tasks",
  Effect.gen(function* () {
    return {
      description:
        "View or update the shared task list for the team. " +
        "Leads should use this to decompose the goal, track ownership, and steer the work. " +
        "Teammates should use it to understand, claim, and complete assigned execution tasks. " +
        "Use action 'list' to see all tasks, 'add' to add new tasks, 'complete' to mark a task done, or 'update' to replace the full list.",
      parameters: TeamTasksParameters,
      execute: (params: Schema.Schema.Type<typeof TeamTasksParameters>, ctx: Tool.Context<TeamTasksMetadata>) =>
        Effect.gen(function* () {
          const teamInfo = yield* Effect.promise(() => Team.findBySession(ctx.sessionID))
          if (!teamInfo) {
            return { title: "Error", output: "You are not part of any team.", metadata: {} }
          }
          const teamName = teamInfo.team.name

          switch (params.action) {
            case "list": {
              const tasks = yield* Effect.promise(() => TeamTasks.list(teamName))
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
              const newTasks: TeamTask[] = params.tasks.map((t) => ({
                ...t,
                depends_on: t.depends_on ? [...t.depends_on] : undefined,
                status: "pending" as const,
              }))
              yield* Effect.promise(() => TeamTasks.add(teamName, newTasks))
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
              yield* Effect.promise(() => TeamTasks.complete(teamName, params.task_id!))
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
              const updateTasks: TeamTask[] = params.tasks.map((t) => ({
                ...t,
                depends_on: t.depends_on ? [...t.depends_on] : undefined,
              }))
              yield* Effect.promise(() => TeamTasks.update(teamName, updateTasks))
              return {
                title: "Task list updated",
                output: `Replaced task list with ${params.tasks.length} task(s).`,
                metadata: {},
              }
            }
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof TeamTasksParameters, TeamTasksMetadata>
  }),
)

/**
 * Claim a pending task from the shared task list.
 */
export const TeamClaimParameters = Schema.Struct({
  task_id: Schema.String.annotate({ description: "The ID of the task to claim" }),
})

type TeamClaimMetadata = {
  taskId?: string
}

export const TeamClaimTool = Tool.define<typeof TeamClaimParameters, TeamClaimMetadata, never>(
  "team_claim",
  Effect.gen(function* () {
    return {
      description:
        "Claim a pending task from the team's shared task list. " +
        "Only pending, unassigned tasks with resolved dependencies can be claimed. " +
        "Uses file locking to prevent race conditions. Teammates should usually claim execution tasks; the lead should usually avoid claiming hands-on work unless intentionally taking a coordination or synthesis task.",
      parameters: TeamClaimParameters,
      execute: (params: Schema.Schema.Type<typeof TeamClaimParameters>, ctx: Tool.Context<TeamClaimMetadata>) =>
        Effect.gen(function* () {
          const teamInfo = yield* Effect.promise(() => Team.findBySession(ctx.sessionID))
          if (!teamInfo) {
            return { title: "Error", output: "You are not part of any team.", metadata: {} }
          }

          const memberName = teamInfo.role === "lead" ? "lead" : teamInfo.memberName!
          const claimed = yield* Effect.promise(() => TeamTasks.claim(teamInfo.team.name, params.task_id, memberName))

          if (claimed) {
            return {
              title: `Claimed task ${params.task_id}`,
              output: `You claimed task "${params.task_id}". It's now in_progress assigned to you.${teamInfo.role === "lead" ? " Leads should usually claim only coordination, integration, or synthesis work." : ""}`,
              metadata: { taskId: params.task_id },
            }
          } else {
            return {
              title: "Claim failed",
              output: `Could not claim task "${params.task_id}". It may already be taken, blocked, or not found.`,
              metadata: {},
            }
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof TeamClaimParameters, TeamClaimMetadata>
  }),
)

/**
 * Approve or reject a teammate's plan — lifts write restrictions on approval.
 */
export const TeamApprovePlanParameters = Schema.Struct({
  name: SafeName.annotate({ description: "Name of the teammate whose plan to review" }),
  approved: Schema.Boolean.annotate({
    description: "true to approve the plan and unlock write access, false to reject",
  }),
  feedback: Schema.optional(Schema.String).annotate({
    description: "Feedback for the teammate — required on rejection, optional on approval",
  }),
})

type TeamApprovePlanMetadata = {
  approved?: boolean
}

export const TeamApprovePlanTool = Tool.define<
  typeof TeamApprovePlanParameters,
  TeamApprovePlanMetadata,
  Session.Service
>(
  "team_approve_plan",
  Effect.gen(function* () {
    const sessions = yield* Session.Service

    return {
      description:
        "Approve or reject a teammate's implementation plan. When a teammate is spawned with " +
        "require_plan_approval=true, they start in read-only mode and must submit a plan. " +
        "Use this tool to approve (unlocks write tools) or reject (teammate revises their plan).",
      parameters: TeamApprovePlanParameters,
      execute: (
        params: Schema.Schema.Type<typeof TeamApprovePlanParameters>,
        ctx: Tool.Context<TeamApprovePlanMetadata>,
      ) =>
        Effect.gen(function* () {
          const teamInfo = yield* Effect.promise(() => Team.findBySession(ctx.sessionID))
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
            const sid = SessionID.make(member.sessionID)
            const session = yield* sessions.get(sid)
            if (session.permission) {
              yield* sessions.setPermission({
                sessionID: sid,
                permission: session.permission.filter(
                  (rule: { pattern: string }) => rule.pattern !== "*:plan-approval",
                ),
              })
            }

            // Update member state
            yield* Effect.promise(() => Team.setMemberPlanApproval(teamInfo.team.name, params.name, "approved"))

            // Notify the teammate
            yield* Effect.promise(() =>
              TeamMessaging.send({
                teamName: teamInfo.team.name,
                from: "lead",
                to: params.name,
                text: params.feedback
                  ? `Your plan has been APPROVED. You now have full write access. Feedback: ${params.feedback}`
                  : "Your plan has been APPROVED. You now have full write access. Proceed with implementation.",
              }),
            )

            yield* Effect.promise(() =>
              Bus.publish(TeamEvent.PlanApproval, {
                teamName: teamInfo.team.name,
                memberName: params.name,
                approved: true,
                feedback: params.feedback,
              }),
            )

            return {
              title: `Plan approved: ${params.name}`,
              output: `Approved "${params.name}"'s plan. Write tools are now unlocked for this teammate.`,
              metadata: { approved: true },
            }
          } else {
            // Rejected — keep read-only mode, mark as rejected.
            // The teammate's next plan submission resets to "pending".
            yield* Effect.promise(() => Team.setMemberPlanApproval(teamInfo.team.name, params.name, "rejected"))

            yield* Effect.promise(() =>
              TeamMessaging.send({
                teamName: teamInfo.team.name,
                from: "lead",
                to: params.name,
                text: `Your plan has been REJECTED. Please revise and resubmit. Feedback: ${params.feedback ?? "No specific feedback provided."}`,
              }),
            )

            yield* Effect.promise(() =>
              Bus.publish(TeamEvent.PlanApproval, {
                teamName: teamInfo.team.name,
                memberName: params.name,
                approved: false,
                feedback: params.feedback,
              }),
            )

            return {
              title: `Plan rejected: ${params.name}`,
              output: `Rejected "${params.name}"'s plan. They remain in read-only mode and should revise.`,
              metadata: { approved: false },
            }
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof TeamApprovePlanParameters, TeamApprovePlanMetadata>
  }),
)

/**
 * Request a teammate to shut down. The teammate can approve or reject.
 */
export const TeamShutdownParameters = Schema.Struct({
  name: SafeName.annotate({ description: "Name of the teammate to shut down" }),
  reason: Schema.optional(Schema.String).annotate({ description: "Reason for the shutdown request" }),
})

type TeamShutdownMetadata = Record<string, never>

export const TeamShutdownTool = Tool.define<typeof TeamShutdownParameters, TeamShutdownMetadata, never>(
  "team_shutdown",
  Effect.gen(function* () {
    return {
      description:
        "Request a teammate to shut down gracefully. The teammate receives the shutdown request " +
        "and can wrap up current work before exiting. Shutdown is authoritative — once requested, " +
        "the teammate will be transitioned to shutdown after processing the message. " +
        "Only the team lead should use this.",
      parameters: TeamShutdownParameters,
      execute: (
        params: Schema.Schema.Type<typeof TeamShutdownParameters>,
        ctx: Tool.Context<TeamShutdownMetadata>,
      ) =>
        Effect.gen(function* () {
          const teamInfo = yield* Effect.promise(() => Team.findBySession(ctx.sessionID))
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

          const result = yield* Effect.promise(() =>
            Team.shutdown({
              teamName: teamInfo.team.name,
              memberName: params.name,
              reason: params.reason,
            }),
          )

          if (result.status === "already_shutdown") {
            return {
              title: "Already shutdown",
              output: `Teammate "${params.name}" is already shut down.`,
              metadata: {},
            }
          }

          if (result.status === "blocked") {
            return {
              title: "Shutdown blocked",
              output: result.reason ?? `Team policy blocked shutdown for "${params.name}".`,
              metadata: {},
            }
          }

          return {
            title: `Shutdown requested: ${params.name}`,
            output: `Shutdown request sent to "${params.name}". They will wrap up current work and stop.`,
            metadata: {},
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof TeamShutdownParameters, TeamShutdownMetadata>
  }),
)

/**
 * Merge teammate worktree branches into the lead branch.
 */
export const TeamMergeParameters = Schema.Struct({
  name: SafeName.annotate({ description: "Team name to merge" }),
  member: Schema.optional(SafeName).annotate({ description: "Optional single teammate to merge" }),
  action: Schema.optional(Schema.Literals(MERGE_ACTION_VALUES)).annotate({ description: "Merge action to run" }),
})

type TeamMergeMetadata = {
  merged?: string[]
  skipped?: string[]
  pending?: string[]
  conflicts?: { name: string; files: string[]; error?: string }[]
}

export const TeamMergeTool = Tool.define<typeof TeamMergeParameters, TeamMergeMetadata, never>(
  "team_merge",
  Effect.gen(function* () {
    return {
      description:
        "Merge teammate worktree branches into the lead session's current branch using normal git merges. " +
        "Use this only for teams created in worktree mode. Teammates should usually be ready, shut down, or errored before merging. " +
        "Use action=continue to finish a resolved conflict, action=abort to cancel an in-progress merge, or action=mark_resolved after manually porting changes and committing them.",
      parameters: TeamMergeParameters,
      execute: (params: Schema.Schema.Type<typeof TeamMergeParameters>, ctx: Tool.Context<TeamMergeMetadata>) =>
        Effect.gen(function* () {
          const info = yield* Effect.promise(() => Team.findBySession(ctx.sessionID))
          if (!info || info.role !== "lead" || info.team.name !== params.name) {
            return {
              title: "Error",
              output: "Only the lead of this team can merge teammate worktrees.",
              metadata: {},
            }
          }

          const action = params.action ?? "merge"
          return yield* Effect.tryPromise({
            try: () => Team.merge(params.name, params.member, action),
            catch: (err) => err,
          }).pipe(
            Effect.map((result) => {
              const lines = [
                `${action === "merge" ? "Merged" : action === "continue" ? "Continued" : action === "abort" ? "Aborted" : "Recorded"} worktrees for team "${params.name}".`,
                result.merged.length ? `Merged: ${result.merged.join(", ")}` : "Merged: none",
                result.skipped.length ? `Skipped: ${result.skipped.join(", ")}` : "Skipped: none",
                result.pending.length ? `Pending: ${result.pending.join(", ")}` : "Pending: none",
              ]
              if (result.conflicts.length) {
                lines.push(
                  "Conflicts:",
                  ...result.conflicts.map(
                    (item: { name: string; files: string[]; error?: string }) =>
                      `- ${item.name}: ${item.files.join(", ") || item.error}`,
                  ),
                  "Resolve the conflict, stage the files, then run team_merge with action=continue. Use action=abort to cancel the in-progress merge or action=mark_resolved after a manual port.",
                )
              }
              return {
                title: `Team merged: ${params.name}`,
                output: lines.join("\n"),
                metadata: result,
              }
            }),
            Effect.catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err)
              return Effect.succeed({
                title: "Merge failed",
                output: `Failed to merge team worktrees: ${msg}`,
                metadata: {},
              })
            }),
          )
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof TeamMergeParameters, TeamMergeMetadata>
  }),
)

/**
 * Clean up the team — remove config and task files.
 */
export const TeamCleanupParameters = Schema.Struct({
  name: SafeName.annotate({ description: "Team name to clean up" }),
  force: Schema.optional(Schema.Boolean).annotate({ description: "Force straggler shutdown before cleanup" }),
})

type TeamCleanupMetadata = Record<string, never>

export const TeamCleanupTool = Tool.define<typeof TeamCleanupParameters, TeamCleanupMetadata, never>(
  "team_cleanup",
  Effect.gen(function* () {
    return {
      description:
        "Clean up the team by removing all team resources (config, task list). " +
        "All teammates must be shut down first. Worktree teams must also run team_merge successfully before cleanup. Only the lead should call this.",
      parameters: TeamCleanupParameters,
      execute: (
        params: Schema.Schema.Type<typeof TeamCleanupParameters>,
        ctx: Tool.Context<TeamCleanupMetadata>,
      ) =>
        Effect.gen(function* () {
          // Authorization: only the lead of this specific team can clean it up
          const teamInfo = yield* Effect.promise(() => Team.findBySession(ctx.sessionID))
          if (!teamInfo || teamInfo.role !== "lead" || teamInfo.team.name !== params.name) {
            return {
              title: "Error",
              output: "Only the lead of this team can clean it up.",
              metadata: {},
            }
          }

          const wasDelegate = teamInfo.team.delegate === true

          return yield* Effect.gen(function* () {
            if (params.force) {
              const team = yield* Effect.promise(() => Team.get(params.name))
              const live = team?.members.filter((member) => member.status !== "shutdown") ?? []
              if (live.length > 0) {
                yield* Effect.promise(() =>
                  Team.forceShutdownAll(params.name, "Forced cleanup requested by the lead."),
                )
                const stop = Date.now() + 5_000
                while (Date.now() < stop) {
                  const next = yield* Effect.promise(() => Team.get(params.name))
                  if (!next || next.members.every((member) => member.status === "shutdown")) break
                  yield* Effect.sleep(`${100} millis`)
                }

                const next = yield* Effect.promise(() => Team.get(params.name))
                const left = next?.members.filter((member) => member.status !== "shutdown") ?? []
                if (left.length > 0) {
                  return yield* Effect.fail(
                    new Error(`Timed out waiting for shutdown: ${left.map((member) => member.name).join(", ")}`),
                  )
                }
              }
            }

            yield* Effect.promise(() => Team.cleanup(params.name))
            return {
              title: `Team cleaned up: ${params.name}`,
              output: [
                `Team "${params.name}" has been cleaned up. All resources removed.`,
                "Resume normal non-team chat behavior unless the user asks you to run a team of agents again.",
                teamInfo.team.worktrees ? "Merged worktree branches remain in the lead branch history." : "",
                wasDelegate ? "Delegate mode restrictions have been removed. You can now use all tools again." : "",
              ]
                .filter(Boolean)
                .join("\n"),
              metadata: {},
            }
          }).pipe(
            Effect.catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err)
              return Effect.succeed({
                title: "Cleanup failed",
                output: `Failed to clean up team: ${msg}`,
                metadata: {},
              })
            }),
          )
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof TeamCleanupParameters, TeamCleanupMetadata>
  }),
)

/**
 * Health check — diagnose stuck teammates, blocked tasks, and undelivered messages.
 */
export const TeamHealthParameters = Schema.Struct({})

type TeamHealthMetadata = {
  issues?: number
}

export const TeamHealthTool = Tool.define<typeof TeamHealthParameters, TeamHealthMetadata, never>(
  "team_health",
  Effect.gen(function* () {
    return {
      description:
        "Diagnose team health issues: stuck teammates (busy too long), blocked tasks " +
        "with unresolvable dependencies, and undelivered inbox messages. Use this when " +
        "the team seems stuck or you suspect something is wrong.",
      parameters: TeamHealthParameters,
      execute: (
        _params: Schema.Schema.Type<typeof TeamHealthParameters>,
        ctx: Tool.Context<TeamHealthMetadata>,
      ) =>
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
            const unread = yield* Effect.promise(() => Inbox.unread(team.name, m.name).catch(() => []))
            if (unread.length > 5) {
              issues.push(`BACKLOG: "${m.name}" has ${unread.length} unread messages`)
            }
          }
          const leadUnread = yield* Effect.promise(() => Inbox.unread(team.name, "lead").catch(() => []))
          if (leadUnread.length > 5) {
            issues.push(`BACKLOG: Lead has ${leadUnread.length} unread messages`)
          }

          // Check for file conflicts
          const conflicts = activeConflicts(team.name, team)
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
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof TeamHealthParameters, TeamHealthMetadata>
  }),
)

/**
 * Restart an idle/errored teammate by re-engaging their prompt loop.
 */
export const TeamRestartParameters = Schema.Struct({
  name: Schema.String.annotate({ description: "Name of the teammate to restart" }),
  message: Schema.String.annotate({
    description: "Instructions for the restarted teammate — what they should do next",
  }),
})

type TeamRestartMetadata = Record<string, never>

export const TeamRestartTool = Tool.define<typeof TeamRestartParameters, TeamRestartMetadata, never>(
  "team_restart",
  Effect.gen(function* () {
    return {
      description:
        "Restart an idle or errored teammate by sending them a new message and waking " +
        "their prompt loop. Cheaper than shutdown + re-spawn because it reuses the existing session.",
      parameters: TeamRestartParameters,
      execute: (
        params: Schema.Schema.Type<typeof TeamRestartParameters>,
        ctx: Tool.Context<TeamRestartMetadata>,
      ) =>
        Effect.gen(function* () {
          const info = yield* Effect.promise(() => Team.findBySession(ctx.sessionID))
          if (!info || info.role !== "lead") {
            return { title: "Error", output: "Only the team lead can restart teammates.", metadata: {} }
          }

          const team = yield* Effect.promise(() => Team.get(info.team.name))
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

          yield* Effect.promise(() =>
            Team.restart({
              teamName: info.team.name,
              memberName: params.name,
              text: params.message,
            }),
          )

          return {
            title: `Restarted: ${params.name}`,
            output: `Sent new instructions to "${params.name}" and triggered auto-wake. They should begin processing shortly.`,
            metadata: {},
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof TeamRestartParameters, TeamRestartMetadata>
  }),
)

export const TeamTools = [
  TeamCreateTool,
  TeamSpawnTool,
  TeamRequestSpawnTool,
  TeamMessageTool,
  TeamReplyTool,
  TeamBroadcastTool,
  TeamDelegateTool,
  TeamInboxTool,
  TeamSubmitResultTool,
  TeamWaitTool,
  TeamCollectTool,
  TeamTasksTool,
  TeamClaimTool,
  TeamApprovePlanTool,
  TeamShutdownAllTool,
  TeamShutdownTool,
  TeamMergeTool,
  TeamCleanupTool,
  TeamPhaseTool,
  TeamStatusTool,
  TeamNotepadTool,
  TeamHealthTool,
  TeamRestartTool,
]

export { TEAM_TOOL_IDS } from "./team-ids"
