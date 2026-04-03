import z from "zod"
import { BusEvent } from "../bus/bus-event"

export const MemberStatus = z.enum(["ready", "busy", "paused", "shutdown_requested", "shutdown", "error"])
export type MemberStatus = z.infer<typeof MemberStatus>

export const CheckpointMode = z.enum(["none", "after_each_write", "after_each_tool"])
export type CheckpointMode = z.infer<typeof CheckpointMode>

export const ResultStatusSchema = z.enum(["success", "partial", "blocked", "failed"])
export type ResultStatus = z.infer<typeof ResultStatusSchema>

export const EvidenceTier = z.enum(["publicly_evidenced", "strong_analogue", "hypothesis"])
export type EvidenceTier = z.infer<typeof EvidenceTier>

export const TeamMode = z.enum(["research", "implementation", "mixed"])
export type TeamMode = z.infer<typeof TeamMode>

export const TeamPhaseLevel = z.enum(["spawning", "discovery", "peer_relay", "synthesis", "delivery", "completed"])
export type TeamPhaseLevel = z.infer<typeof TeamPhaseLevel>

export const OutputFormat = z.enum(["free", "single_synthesis", "structured_report"])
export type OutputFormat = z.infer<typeof OutputFormat>

export const SubmittedResultSchema = z.object({
  title: z.string().max(120),
  summary: z.string().max(2000),
  status: ResultStatusSchema,
  files_changed: z.array(z.string()).optional(),
  evidence_tier: EvidenceTier.optional(),
  evidence: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  blockers: z.string().optional(),
  task_id: z.string().optional(),
})
export type SubmittedResult = z.infer<typeof SubmittedResultSchema>

export const TeamScopeSchema = z.object({
  path_excludes: z.array(z.string()).optional(),
  path_includes: z.array(z.string()).optional(),
  bash_allowlist: z.array(z.string()).optional(),
})
export type TeamScope = z.infer<typeof TeamScopeSchema>

export const TeamErrorKind = z.enum([
  "tool_failed",
  "policy_blocked",
  "timeout",
  "message_undelivered",
  "member_crashed",
  "budget_exceeded",
])
export type TeamErrorKind = z.infer<typeof TeamErrorKind>

export const MemberPhase = z.enum(["researching", "implementing", "testing", "waiting_approval", "reporting", "idle"])
export type MemberPhase = z.infer<typeof MemberPhase>

export const MessageType = z.enum([
  "message",
  "question",
  "status",
  "plan",
  "error",
  "result",
  "system",
  "spawn_request",
])
export type MessageType = z.infer<typeof MessageType>

export const MessagePriority = z.enum(["normal", "urgent", "low"])
export type MessagePriority = z.infer<typeof MessagePriority>

export const ExecutionStatus = z.enum([
  "idle",
  "starting",
  "running",
  "cancel_requested",
  "cancelling",
  "cancelled",
  "completing",
  "completed",
  "failed",
  "timed_out",
])
export type ExecutionStatus = z.infer<typeof ExecutionStatus>

export const ACTIVE_EXECUTION = new Set<ExecutionStatus>([
  "starting",
  "running",
  "cancel_requested",
  "cancelling",
  "completing",
])

export const MergeStatus = z.enum(["pending", "skipped", "merged", "conflict"])
export type MergeStatus = z.infer<typeof MergeStatus>

/** Validates safe identifiers for team/member names — prevents path traversal */
const SafeName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "Must be lowercase alphanumeric with hyphens, 1-64 chars")

export const TeamNameSchema = SafeName
export const MemberNameSchema = SafeName

export const TeamMemberSchema = z.object({
  name: SafeName,
  sessionID: z.string(),
  agent: z.string(),
  status: MemberStatus,
  execution_status: ExecutionStatus.optional(),
  updated: z.number().optional(),
  started: z.number().optional(),
  prompt: z.string().optional(),
  /** Model this teammate is using, in "providerID/modelID" format. */
  model: z.string().optional(),
  planApproval: z.enum(["none", "pending", "approved", "rejected"]).optional(),
  checkpoint: CheckpointMode.optional(),
  activeDelegations: z.number().int().nonnegative().optional(),
  maxCost: z.number().nonnegative().optional(),
  worktreePath: z.string().optional(),
  worktreeBranch: z.string().optional(),
  mergeStatus: MergeStatus.optional(),
  mergeError: z.string().optional(),
  mergedAt: z.number().optional(),
  scope: TeamScopeSchema.optional(),
  mode: TeamMode.optional(),
  phase: MemberPhase.optional(),
  last_result_at: z.number().optional(),
  result_deadline: z.number().optional(),
  assigned_at: z.number().optional(),
  error_kind: TeamErrorKind.optional(),
})
export type TeamMember = z.infer<typeof TeamMemberSchema>

export const PendingSpawnRequestSchema = z.object({
  id: z.string(),
  requested_by: SafeName,
  agent: z.string(),
  rationale: z.string(),
  name: SafeName.optional(),
  prompt: z.string().optional(),
  created: z.number(),
})
export type PendingSpawnRequest = z.infer<typeof PendingSpawnRequestSchema>
export const PendingSpawnRequestPublicSchema = PendingSpawnRequestSchema.omit({ rationale: true, prompt: true })

export const TeamInfoSchema = z.object({
  name: SafeName,
  leadSessionID: z.string(),
  members: z.array(TeamMemberSchema),
  created: z.number(),
  delegate: z.boolean().optional(),
  collect_strict: z.boolean().optional(),
  maxCost: z.number().nonnegative().optional(),
  require_result_before_shutdown: z.boolean().optional(),
  scope: TeamScopeSchema.optional(),
  receipts: z.boolean().optional(),
  worktrees: z.boolean().optional(),
  team_phase: TeamPhaseLevel.optional(),
  delivered: z.boolean().optional(),
  output_format: OutputFormat.optional(),
  pending_spawn_requests: z.array(PendingSpawnRequestSchema).optional(),
})
export type TeamInfo = z.infer<typeof TeamInfoSchema>

export const TeamMemberPublicSchema = TeamMemberSchema.omit({
  prompt: true,
  sessionID: true,
  updated: true,
  started: true,
})
export const TeamInfoPublicSchema = TeamInfoSchema.omit({ leadSessionID: true, members: true }).extend({
  members: z.array(TeamMemberPublicSchema),
  pending_spawn_requests: z.array(PendingSpawnRequestPublicSchema).optional(),
})

export const TeamMemberSessionSchema = TeamMemberSchema.omit({ prompt: true, updated: true, started: true })
export const TeamInfoSessionSchema = TeamInfoSchema.omit({ leadSessionID: true, members: true }).extend({
  members: z.array(TeamMemberSessionSchema),
})

export const TeamTaskSchema = z.object({
  id: z.string(),
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "cancelled", "blocked"]),
  priority: z.enum(["high", "medium", "low"]),
  assignee: z.string().optional(),
  depends_on: z.array(z.string()).optional(),
})
export type TeamTask = z.infer<typeof TeamTaskSchema>

export namespace TeamEvent {
  export const Created = BusEvent.define(
    "team.created",
    z.object({
      team: TeamInfoSchema,
    }),
  )

  export const MemberSpawned = BusEvent.define(
    "team.member.spawned",
    z.object({
      teamName: z.string(),
      member: TeamMemberSchema,
    }),
  )

  export const MemberStatusChanged = BusEvent.define(
    "team.member.status",
    z.object({
      teamName: z.string(),
      memberName: z.string(),
      status: MemberStatus,
    }),
  )

  export const MemberExecutionChanged = BusEvent.define(
    "team.member.execution",
    z.object({
      teamName: z.string(),
      memberName: z.string(),
      status: ExecutionStatus,
    }),
  )

  export const Message = BusEvent.define(
    "team.message",
    z.object({
      teamName: z.string(),
      from: z.string(),
      to: z.string(),
      text: z.string(),
      type: MessageType.optional(),
      priority: MessagePriority.optional(),
      threadId: z.string().optional(),
      replyTo: z.string().optional(),
    }),
  )

  export const Broadcast = BusEvent.define(
    "team.broadcast",
    z.object({
      teamName: z.string(),
      from: z.string(),
      text: z.string(),
      type: MessageType.optional(),
      priority: MessagePriority.optional(),
      threadId: z.string().optional(),
    }),
  )

  export const TaskUpdated = BusEvent.define(
    "team.task.updated",
    z.object({
      teamName: z.string(),
      tasks: z.array(TeamTaskSchema),
    }),
  )

  export const TaskClaimed = BusEvent.define(
    "team.task.claimed",
    z.object({
      teamName: z.string(),
      taskId: z.string(),
      memberName: z.string(),
    }),
  )

  export const SpawnRequested = BusEvent.define(
    "team.spawn.requested",
    z.object({
      teamName: z.string(),
      request: PendingSpawnRequestSchema,
    }),
  )

  export const ShutdownRequest = BusEvent.define(
    "team.shutdown.request",
    z.object({
      teamName: z.string(),
      memberName: z.string(),
    }),
  )

  export const PlanApproval = BusEvent.define(
    "team.plan.approval",
    z.object({
      teamName: z.string(),
      memberName: z.string(),
      approved: z.boolean(),
      feedback: z.string().optional(),
    }),
  )

  export const ResultSubmitted = BusEvent.define(
    "team.result.submitted",
    z.object({
      teamName: z.string(),
      memberName: z.string(),
      result: SubmittedResultSchema,
      taskId: z.string().optional(),
    }),
  )

  export const MessageUndelivered = BusEvent.define(
    "team.message.undelivered",
    z.object({
      teamName: z.string(),
      from: z.string(),
      to: z.string(),
      messageID: z.string(),
      error: z.string().optional(),
    }),
  )

  export const MessageRead = BusEvent.define(
    "team.message.read",
    z.object({
      teamName: z.string(),
      agentName: z.string(),
      count: z.number(),
    }),
  )

  export const Cleaned = BusEvent.define(
    "team.cleaned",
    z.object({
      teamName: z.string(),
      leadSessionID: z.string(),
      delegate: z.boolean(),
    }),
  )

  export const AllMembersShutdown = BusEvent.define(
    "team.all-members-shutdown",
    z.object({
      teamName: z.string(),
      leadSessionID: z.string(),
      grace: z.number(),
      cleanupAt: z.number(),
    }),
  )

  export const MemberTimeout = BusEvent.define(
    "team.member.timeout",
    z.object({
      teamName: z.string(),
      memberName: z.string(),
      elapsed: z.number(),
      limit: z.number(),
    }),
  )

  export const FileConflict = BusEvent.define(
    "team.file.conflict",
    z.object({
      teamName: z.string(),
      filepath: z.string(),
      members: z.array(z.string()),
    }),
  )

  export const InboxPruned = BusEvent.define(
    "team.inbox.pruned",
    z.object({
      teamName: z.string(),
      agentName: z.string(),
      removed: z.number(),
    }),
  )

  export const TeamPhaseChanged = BusEvent.define(
    "team.phase.changed",
    z.object({
      teamName: z.string(),
      phase: TeamPhaseLevel,
      previous: TeamPhaseLevel.optional(),
    }),
  )
}
