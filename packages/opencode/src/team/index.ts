import z from "zod"
import path from "path"
import * as Log from "@opencode-ai/core/util/log"
import { Bus } from "../bus"
import { Instance } from "../project/instance"
import { Storage } from "./runtime"
import * as Lock from "../util/lock"
import { fn } from "../util/fn"
import {
  TeamEvent,
  TeamNameSchema,
  MemberNameSchema,
  MemberStatus as MemberStatusSchema,
  CheckpointMode,
  ExecutionStatus,
  EvidenceTier,
  OutputFormat,
  ResultStatusSchema,
  SubmittedResultSchema,
  TeamMode,
  TeamPhaseLevel,
  TeamScopeSchema,
  TeamErrorKind,
  MergeStatus,
  MemberPhase,
  TeamInfoSchema,
  TeamMemberSchema,
  TeamTaskSchema,
  PendingSpawnRequestSchema,
  PendingSpawnRequestPublicSchema,
  type TeamInfo,
  type TeamMember,
  type TeamTask,
  type MemberStatus,
  type CheckpointMode as CheckpointModeType,
  type OutputFormat as OutputFormatType,
  type TeamMode as TeamModeType,
  type TeamPhaseLevel as TeamPhaseLevelType,
  type TeamScope as TeamScopeType,
  type TeamErrorKind as TeamErrorKindType,
  type MergeStatus as MergeStatusType,
  type MemberPhase as MemberPhaseType,
  type PendingSpawnRequest,
  type ExecutionStatus as ExecutionStatusType,
} from "./events"
import { TeamPolicy } from "./policy"
import { MessageV2 } from "../session/message-v2"
import { TeamScope } from "./scope"
import { TEAM_LEAD_ONLY_IDS, TEAM_MEMBER_ALLOWED_IDS } from "../tool/team-ids"
import { permGlob, permPath } from "../tool/perm"

export {
  TeamEvent,
  TeamNameSchema,
  MemberNameSchema,
  CheckpointMode,
  ExecutionStatus,
  EvidenceTier,
  OutputFormat,
  ResultStatusSchema,
  SubmittedResultSchema,
  TeamMode,
  TeamPhaseLevel,
  TeamScopeSchema,
  TeamErrorKind,
  MergeStatus,
  MemberPhase,
  MessagePriority,
  MessageType,
  type MessagePriority as MessagePriorityType,
  type MessageType as MessageTypeType,
  TeamInfoSchema,
  TeamInfoPublicSchema,
  TeamInfoSessionSchema,
  TeamTaskSchema,
  PendingSpawnRequestSchema,
  PendingSpawnRequestPublicSchema,
  type TeamInfo,
  type TeamMember,
  type TeamTask,
  type TeamScope,
  type PendingSpawnRequest,
} from "./events"

/** Write tools that are denied during plan-approval or delegate mode */
export const WRITE_TOOLS = ["bash", "write", "edit", "multiedit", "apply_patch"] as const
const CHILD_LOCK_TOOLS = ["task", "team_delegate"] as const
const LOCKED_TOOLS = [...WRITE_TOOLS, ...CHILD_LOCK_TOOLS] as const
export const DELEGATE_PATTERN = "*:delegate"

const log = Log.create({ service: "team" })

type Rule = {
  permission: string
  pattern: string
  action: "deny" | "allow" | "ask"
}

export function addDelegateRules(rules: Rule[]) {
  return [
    ...rules,
    ...WRITE_TOOLS.filter(
      (permission) => !rules.some((rule) => rule.permission === permission && rule.pattern === DELEGATE_PATTERN),
    ).map((permission) => ({
      permission,
      pattern: DELEGATE_PATTERN,
      action: "deny" as const,
    })),
  ]
}

export function removeDelegateRules(rules: Rule[]) {
  return rules.filter((rule) => !(rule.action === "deny" && rule.pattern === DELEGATE_PATTERN))
}

/** Storage key for a team's config */
function configKey(name: string): string[] {
  return ["team", Instance.project.id, name]
}

/** Storage key for a team's task list — separate prefix from "team" so
 *  Storage.list(["team", projectID]) only returns config keys, not task data */
function tasksKey(name: string): string[] {
  return ["team_tasks", Instance.project.id, name]
}

const TERMINAL_EXECUTION_STATES = new Set<ExecutionStatusType>([
  "idle",
  "cancelled",
  "completed",
  "failed",
  "timed_out",
])

const CREATE_LOCK_KEY = () => `team:create:${Instance.project.id}`
const AUTO_CLEANUP_GRACE = 60_000
const SHUTDOWN_TIMEOUT = 30_000
const auto = new Map<string, ReturnType<typeof setTimeout>>()
const checkpoint = new Set<string>()
const cleaning = new Set<string>()

function autoKey(name: string) {
  return `${Instance.project.id}:${name}`
}

function traceKey(sessionID: string): string[] {
  return ["team_trace", Instance.project.id, sessionID]
}

const TraceSchema = z.object({
  parentTeam: TeamNameSchema,
  parentMember: MemberNameSchema,
  mode: z.enum(["task", "delegate"]),
})
type Trace = z.infer<typeof TraceSchema>

const SessionMetaSchema = z.object({
  name: MemberNameSchema,
  teamName: TeamNameSchema,
  agent: z.string(),
  model: z.string().optional(),
  prompt: z.string().optional(),
})
type SessionMeta = z.infer<typeof SessionMetaSchema>

type Link = {
  teamName: string
  role: "lead" | "member"
  memberName?: string
}

// TODO(team): Upstream removed `Instance.state(...)`. The new equivalent is
// `InstanceState.make<T>(Effect.fn(...))` from inside Effect.gen, which is
// scoped to the instance lifecycle and disposed when the instance is torn
// down. Until the team module is ported to Effect, we use a plain
// per-directory map keyed by `Instance.directory`. This loses the
// scope-tied cleanup (state outlives instance disposal until process exit)
// but matches the previous read/write semantics.
type TeamCache = {
  links: Map<string, Link>
  traces: Map<string, Trace>
  hydrated: boolean
}
const cacheMap = new Map<string, TeamCache>()
function cache(): TeamCache {
  const key = Instance.directory
  let entry = cacheMap.get(key)
  if (!entry) {
    entry = {
      links: new Map<string, Link>(),
      traces: new Map<string, Trace>(),
      hydrated: false,
    }
    cacheMap.set(key, entry)
  }
  return entry
}

function memberKey(sessionID: string): string[] {
  return ["team_member", Instance.project.id, sessionID]
}

function indexTeam(team: Pick<TeamInfo, "name" | "leadSessionID" | "members">) {
  cache().links.set(team.leadSessionID, { teamName: team.name, role: "lead" })
  for (const member of team.members) {
    cache().links.set(member.sessionID, { teamName: team.name, role: "member", memberName: member.name })
  }
}

function dropTeam(team: Pick<TeamInfo, "leadSessionID" | "members">) {
  cache().links.delete(team.leadSessionID)
  for (const member of team.members) {
    cache().links.delete(member.sessionID)
  }
}

async function hydrateLinks() {
  const state = cache()
  if (state.hydrated) return
  state.links.clear()
  for (const team of await Team.list()) {
    indexTeam(team)
  }
  state.hydrated = true
}

async function resolveLink(sessionID: string, hit: Link) {
  const team = await Team.get(hit.teamName)
  if (!team) {
    cache().links.delete(sessionID)
    return
  }
  if (hit.role === "lead") {
    if (team.leadSessionID === sessionID) return { team, role: "lead" as const }
    cache().links.delete(sessionID)
    return
  }
  if (!hit.memberName) {
    cache().links.delete(sessionID)
    return
  }
  const member = team.members.find((item: TeamMember) => item.name === hit.memberName && item.sessionID === sessionID)
  if (member) return { team, role: "member" as const, memberName: hit.memberName }
  cache().links.delete(sessionID)
}

async function writeSessionMeta(sessionID: string, meta: SessionMeta) {
  await Storage.write(memberKey(sessionID), SessionMetaSchema.parse(meta))
}

async function readSessionMeta(sessionID: string): Promise<SessionMeta | undefined> {
  try {
    return SessionMetaSchema.parse(await Storage.read<SessionMeta>(memberKey(sessionID)))
  } catch {
    return undefined
  }
}

async function removeSessionMeta(sessionID: string) {
  await Storage.remove(memberKey(sessionID)).catch(() => undefined)
}

function clearAuto(name: string) {
  const key = autoKey(name)
  const timer = auto.get(key)
  if (!timer) return false
  clearTimeout(timer)
  auto.delete(key)
  return true
}

function rulePath(input: string) {
  return input.replaceAll("\\", "/")
}

function scopeEmpty(scope?: TeamScopeType) {
  return !scope?.path_excludes?.length && !scope?.path_includes?.length && !scope?.bash_allowlist?.length
}

function absoluteRule(dir: string, input: string) {
  return rulePath(path.resolve(dir, input))
}

function relativeRule(dir: string, input: string) {
  return permPath(path.resolve(dir, input), { dir, root: Instance.worktree })
}

function scopeRules(scope: TeamScopeType | undefined, dir: string): Rule[] {
  if (scopeEmpty(scope)) return []
  const rules: Rule[] = []
  const include = scope?.path_includes ?? []
  const exclude = scope?.path_excludes ?? []

  if (include.length) {
    rules.push({ permission: "read", pattern: "**", action: "deny" })
    rules.push(
      ...include.map((item) => ({ permission: "read", pattern: absoluteRule(dir, item), action: "allow" as const })),
    )
    rules.push({ permission: "edit", pattern: "**", action: "deny" })
    rules.push(
      ...include.map((item) => ({ permission: "edit", pattern: relativeRule(dir, item), action: "allow" as const })),
    )
  }

  rules.push(
    ...exclude.flatMap((item) => [
      { permission: "read", pattern: absoluteRule(dir, item), action: "deny" as const },
      { permission: "edit", pattern: relativeRule(dir, item), action: "deny" as const },
    ]),
  )

  if (scope?.bash_allowlist?.length) {
    rules.push({ permission: "bash", pattern: "**", action: "deny" })
    rules.push(...scope.bash_allowlist.map((item) => ({ permission: "bash", pattern: item, action: "allow" as const })))
  }

  return rules
}

async function leadDir(leadSessionID: string) {
  const { Session } = await import("./runtime")
  const { SessionID } = await import("../session/schema")
  const session = await Session.get(SessionID.make(leadSessionID)).catch(() => undefined)
  return session?.directory ?? Instance.directory
}

async function wake(teamName: string, name: string, sessionID: string) {
  const { SessionPrompt } = await import("./runtime")
  const { SessionStatus } = await import("./runtime")
  const { SessionID } = await import("../session/schema")

  const sid = SessionID.make(sessionID)
  const status = await SessionStatus.get(sid)
  if (status.type !== "idle") return

  SessionPrompt.loop({ sessionID: sid })
    .then(async () => {
      const team = await Team.get(teamName)
      const member = team?.members.find((item) => item.name === name)
      if (member?.status !== "shutdown_requested") return
      await Team.transitionMemberStatus(teamName, name, "shutdown")
    })
    .catch(() => {})
}

function timeout(teamName: string, name: string, sessionID: string) {
  setTimeout(async () => {
    const team = await Team.get(teamName)
    const member = team?.members.find((item) => item.name === name)
    if (!member || member.status === "shutdown") return

    const ok = (await Team.cancelMember(teamName, name)) || (await stopped(sessionID))
    if (ok) {
      await Team.transitionMemberStatus(teamName, name, "shutdown", { force: true })
      return
    }

    await noticeLead(
      teamName,
      `Timed out waiting for "${name}" to stop. Their session is still running, so cleanup will stay blocked until it exits.`,
    )
  }, SHUTDOWN_TIMEOUT)
}

async function noticeLead(teamName: string, text: string, priority: "normal" | "urgent" = "urgent") {
  const { Inbox } = await import("./inbox")
  const { TeamMessaging } = await import("./messaging")
  await Inbox.write(teamName, "lead", {
    id: `im_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    from: "system",
    text,
    timestamp: Date.now(),
    type: "system",
    priority,
  }).catch(() => undefined)
  await Bus.publish(TeamEvent.Message, {
    teamName,
    from: "system",
    to: "lead",
    text,
    type: "system",
    priority,
  }).catch(() => undefined)
  void TeamMessaging.flush(teamName, "lead").catch(() => undefined)
}

const MEMBER_TRANSITIONS: Record<MemberStatus, MemberStatus[]> = {
  ready: ["busy", "paused", "shutdown_requested", "shutdown", "error"],
  busy: ["ready", "paused", "shutdown_requested", "error"],
  paused: ["busy", "shutdown_requested", "shutdown", "error"],
  shutdown_requested: ["shutdown", "error"],
  shutdown: [],
  error: ["ready", "shutdown_requested", "shutdown"],
}

const EXECUTION_TRANSITIONS: Record<ExecutionStatusType, ExecutionStatusType[]> = {
  idle: ["starting"],
  starting: ["running", "cancel_requested", "cancelling", "failed", "timed_out"],
  running: ["cancel_requested", "cancelling", "completing", "failed", "timed_out"],
  cancel_requested: ["cancelling", "cancelled", "failed", "timed_out"],
  cancelling: ["cancelled", "failed", "timed_out"],
  cancelled: ["idle"],
  completing: ["completed", "failed", "timed_out"],
  completed: ["idle"],
  failed: ["idle"],
  timed_out: ["idle"],
}

function normalizeMember(member: TeamMember): TeamMember {
  const status = MemberStatusSchema.parse(member.status)
  const execution_status = ExecutionStatus.safeParse(member.execution_status).success
    ? member.execution_status
    : status === "busy"
      ? "running"
      : "idle"
  return {
    ...member,
    status,
    execution_status,
    checkpoint: CheckpointMode.safeParse(member.checkpoint).success ? member.checkpoint : "none",
    activeDelegations: Math.max(0, member.activeDelegations ?? 0),
    maxCost: typeof member.maxCost === "number" && Number.isFinite(member.maxCost) ? member.maxCost : undefined,
    worktreePath: typeof member.worktreePath === "string" ? member.worktreePath : undefined,
    worktreeBranch: typeof member.worktreeBranch === "string" ? member.worktreeBranch : undefined,
    mergeStatus: MergeStatus.safeParse(member.mergeStatus).success
      ? member.mergeStatus
      : typeof member.worktreeBranch === "string"
        ? "pending"
        : undefined,
    mergeError: typeof member.mergeError === "string" ? member.mergeError : undefined,
    mergedAt: typeof member.mergedAt === "number" && Number.isFinite(member.mergedAt) ? member.mergedAt : undefined,
    scope: TeamScopeSchema.safeParse(member.scope).success ? member.scope : undefined,
    mode: TeamMode.safeParse(member.mode).success ? member.mode : "mixed",
    phase: MemberPhase.safeParse(member.phase).success ? member.phase : undefined,
    last_result_at:
      typeof member.last_result_at === "number" && Number.isFinite(member.last_result_at)
        ? member.last_result_at
        : undefined,
    result_deadline:
      typeof member.result_deadline === "number" && Number.isFinite(member.result_deadline)
        ? member.result_deadline
        : undefined,
    assigned_at:
      typeof member.assigned_at === "number" && Number.isFinite(member.assigned_at)
        ? member.assigned_at
        : status === "busy"
          ? (member.started ?? member.updated)
          : undefined,
    error_kind: TeamErrorKind.safeParse(member.error_kind).success ? member.error_kind : undefined,
  }
}

function normalizeTeam(team: TeamInfo): TeamInfo {
  return {
    ...team,
    members: team.members.map(normalizeMember),
    collect_strict: typeof team.collect_strict === "boolean" ? team.collect_strict : false,
    maxCost: typeof team.maxCost === "number" && Number.isFinite(team.maxCost) ? team.maxCost : undefined,
    require_result_before_shutdown:
      typeof team.require_result_before_shutdown === "boolean" ? team.require_result_before_shutdown : false,
    receipts: typeof team.receipts === "boolean" ? team.receipts : false,
    worktrees: typeof team.worktrees === "boolean" ? team.worktrees : false,
    scope: TeamScopeSchema.safeParse(team.scope).success ? team.scope : undefined,
    team_phase: TeamPhaseLevel.safeParse(team.team_phase).success ? team.team_phase : undefined,
    delivered: typeof team.delivered === "boolean" ? team.delivered : false,
    output_format: OutputFormat.safeParse(team.output_format).success ? team.output_format : "free",
    pending_spawn_requests: (team.pending_spawn_requests ?? []).map((item) => PendingSpawnRequestSchema.parse(item)),
  }
}

function spawnRequestId() {
  return `spr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function checkpointText(mode: CheckpointModeType) {
  if (mode === "after_each_write") return "after each write/edit/bash/apply_patch tool call"
  if (mode === "after_each_tool") return "after each tool call"
  return ""
}

function checkpointMatch(mode: CheckpointModeType, tool: string) {
  if (mode === "after_each_tool") return true
  if (mode === "after_each_write") return WRITE_TOOLS.includes(tool as (typeof WRITE_TOOLS)[number])
  return false
}

function lockRules(pattern: string) {
  return LOCKED_TOOLS.map((permission) => ({
    permission,
    pattern,
    action: "deny" as const,
  }))
}

async function childPermission(sessionID: string, rules: Rule[]) {
  const { Session } = await import("./runtime")
  const { SessionID } = await import("../session/schema")
  const session = await Session.get(SessionID.make(sessionID)).catch(() => undefined)
  return [
    ...rules,
    ...((session?.permission ?? []).filter(
      (rule) => rule.action === "deny" && rule.pattern !== DELEGATE_PATTERN,
    ) as Rule[]),
  ]
}

async function stopped(sessionID: string) {
  const { SessionStatus } = await import("./runtime")
  const { SessionID } = await import("../session/schema")
  const status = await SessionStatus.get(SessionID.make(sessionID))
  return status.type === "idle"
}

function state(message: string) {
  const err = new Error(message)
  err.name = "TeamStateError"
  return err
}

function canTransition<T extends string>(current: T, next: T, map: Record<T, T[]>) {
  if (current === next) return true
  return map[current]?.includes(next) === true
}

function sessionMeta(text: string): SessionMeta | undefined {
  const head = text.match(/You are "([^"]+)", a teammate in team "([^"]+)"\./)
  if (!head) return
  const member = MemberNameSchema.safeParse(head[1])
  const team = TeamNameSchema.safeParse(head[2])
  if (!member.success || !team.success) return
  const agent = text.match(/Your agent type is "([^"]+)"/)?.[1] ?? "general"
  const model = text.match(/using model ([^\.]+)\./)?.[1]
  const prompt = text.split("\nYour instructions:\n")[1]?.trim() || undefined
  return {
    name: member.data,
    teamName: team.data,
    agent,
    model,
    prompt,
  }
}

export namespace Team {
  export function cancelAutoCleanup(teamName?: string) {
    if (teamName) return clearAuto(teamName)

    const prefix = `${Instance.project.id}:`
    let cleared = false
    for (const [key, timer] of auto) {
      if (!key.startsWith(prefix)) continue
      clearTimeout(timer)
      auto.delete(key)
      cleared = true
    }
    return cleared
  }

  /**
   * Subscribe to member status changes and auto-cleanup teams
   * when all members have reached "shutdown" status.
   * Called once during InstanceBootstrap.
   */
  export function autoCleanup(options?: { grace?: number }): () => void {
    const grace = options?.grace ?? AUTO_CLEANUP_GRACE
    const offStatus = Bus.subscribe(TeamEvent.MemberStatusChanged, async (event) => {
      if (event.properties.status !== "shutdown") return

      const team = await get(event.properties.teamName)
      if (!team) return
      if (team.members.length === 0) return
      if (team.members.some((m) => m.status !== "shutdown")) return
      if (team.worktrees) {
        await noticeLead(
          team.name,
          `All teammates in "${team.name}" are shut down. This team uses isolated worktrees, so run team_merge and then team_cleanup explicitly.`,
        )
        return
      }
      if (auto.has(autoKey(team.name))) return

      const cleanupAt = Date.now() + grace
      auto.set(
        autoKey(team.name),
        setTimeout(async () => {
          auto.delete(autoKey(team.name))

          const next = await get(team.name)
          if (!next) return
          if (next.members.length === 0) return
          if (next.members.some((member) => member.status !== "shutdown")) return

          log.info("auto-cleanup grace elapsed, cleaning team", { teamName: next.name, grace })
          try {
            await Team.cleanup(next.name)
          } catch (err: unknown) {
            log.warn("auto-cleanup failed", {
              teamName: next.name,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }, grace),
      )

      log.info("all members shutdown, scheduling auto-cleanup", { teamName: team.name, grace })
      await Bus.publish(TeamEvent.AllMembersShutdown, {
        teamName: team.name,
        leadSessionID: team.leadSessionID,
        grace,
        cleanupAt,
      })
    })

    const offCleaned = Bus.subscribe(TeamEvent.Cleaned, (event) => {
      clearAuto(event.properties.teamName)
    })

    return () => {
      offStatus()
      offCleaned()
    }
  }

  export function trackResults() {
    return Bus.subscribe(TeamEvent.ResultSubmitted, async (event) => {
      await setMemberResultAt(event.properties.teamName, event.properties.memberName, Date.now())
    })
  }

  /**
   * Listen for TeamEvent.Cleaned and restore session permissions.
   * This decouples the team module from the session module —
   * cleanup only publishes the event, this listener handles session side-effects.
   */
  export function onCleanedRestorePermissions(): () => void {
    return Bus.subscribe(TeamEvent.Cleaned, async (event) => {
      if (!event.properties.delegate) return

      try {
        const { Session } = await import("./runtime")
        const { SessionID } = await import("../session/schema")
        const session = await Session.get(SessionID.make(event.properties.leadSessionID))
        await Session.setPermission({
          sessionID: SessionID.make(event.properties.leadSessionID),
          permission: removeDelegateRules(session.permission ?? []),
        })
        log.info("restored lead session permissions", {
          teamName: event.properties.teamName,
          sessionID: event.properties.leadSessionID,
        })
      } catch (err: unknown) {
        log.warn("failed to restore lead session permissions", {
          teamName: event.properties.teamName,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
  }

  /**
   * Create a new team. The lead session is the caller's session.
   */
  export const create = fn(
    z.object({
      name: TeamNameSchema,
      leadSessionID: z.string(),
      delegate: z.boolean().optional(),
      collect_strict: z.boolean().optional(),
      maxCost: z.number().nonnegative().optional(),
      require_result_before_shutdown: z.boolean().optional(),
      receipts: z.boolean().optional(),
      worktrees: z.boolean().optional(),
      output_format: OutputFormat.optional(),
      team_phase: TeamPhaseLevel.optional(),
      delivered: z.boolean().optional(),
    }),
    async (input) => {
      using _ = await Lock.write(CREATE_LOCK_KEY())

      const existing = await get(input.name)
      if (existing) throw new Error(`Team "${input.name}" already exists`)

      const lead = await findBySession(input.leadSessionID)
      if (lead?.role === "lead")
        throw new Error(`Session is already leading team "${lead.team.name}". Only one team per session is allowed.`)
      if (lead?.role === "member")
        throw new Error(`This session is a teammate in "${lead.team.name}". Teammates cannot create new teams.`)

      const team: TeamInfo = {
        name: input.name,
        leadSessionID: input.leadSessionID,
        members: [],
        created: Date.now(),
        collect_strict: input.collect_strict ?? false,
        receipts: input.receipts ?? false,
        worktrees: input.worktrees ?? false,
        output_format: input.output_format ?? "free",
        delivered: input.delivered ?? false,
        ...(typeof input.maxCost === "number" ? { maxCost: input.maxCost } : {}),
        require_result_before_shutdown: input.require_result_before_shutdown ?? false,
        pending_spawn_requests: [],
        ...(input.delegate ? { delegate: true } : {}),
        ...(input.team_phase ? { team_phase: input.team_phase } : {}),
      }

      await Storage.write(configKey(input.name), team)
      await Storage.write(tasksKey(input.name), [] as TeamTask[])
      indexTeam(team)

      log.info("team created", { name: input.name, leadSessionID: input.leadSessionID })
      await Bus.publish(TeamEvent.Created, { team })
      return team
    },
  )

  /**
   * Get a team by name. Returns undefined if not found.
   */
  export const get = fn(z.string(), async (name) => {
    try {
      return normalizeTeam(TeamInfoSchema.parse(await Storage.read<TeamInfo>(configKey(name))))
    } catch {
      return undefined
    }
  })

  /**
   * List all teams in this project.
   */
  export async function list(): Promise<TeamInfo[]> {
    try {
      const keys = await Storage.list(["team", Instance.project.id])
      return (
        await Promise.all(
          keys.map((key) =>
            Storage.read<TeamInfo>(key)
              .then(TeamInfoSchema.parse)
              .catch(() => undefined),
          ),
        )
      )
        .filter((t): t is TeamInfo => t !== undefined)
        .map(normalizeTeam)
    } catch {
      return []
    }
  }

  /**
   * Add a member to a team (atomic via Storage.update).
   * Rejects duplicate names (case-insensitive), duplicate sessionIDs, and "lead" as a name.
   */
  export async function addMember(teamName: string, member: TeamMember): Promise<void> {
    const next = TeamMemberSchema.parse(member)
    const lower = next.name.toLowerCase()
    if (lower === "lead") throw new Error(`Name "lead" is reserved and cannot be used for a teammate.`)
    const now = Date.now()

    await Storage.update<TeamInfo>(configKey(teamName), (draft) => {
      if (draft.members.some((m) => m.name.toLowerCase() === lower))
        throw new Error(`Teammate "${next.name}" already exists in team "${teamName}" (case-insensitive)`)
      if (draft.members.some((m) => m.sessionID === next.sessionID))
        throw new Error(`Session "${next.sessionID}" is already registered in team "${teamName}"`)
      draft.members.push({
        ...next,
        updated: next.updated ?? now,
        ...(next.status === "busy" ? { assigned_at: next.assigned_at ?? now } : {}),
      })
    })

    log.info("member added", { teamName, member: next.name, agent: next.agent })
    cache().links.set(next.sessionID, { teamName, role: "member", memberName: next.name })
    await Bus.publish(TeamEvent.MemberSpawned, { teamName, member: next })
  }

  export async function transitionMemberStatus(
    teamName: string,
    memberName: string,
    status: MemberStatus,
    options?: { guard?: boolean; force?: boolean },
  ): Promise<boolean> {
    let changed = false
    let agent = ""
    let executionStatus: ExecutionStatusType = "idle"
    let runtime = 0
    try {
      await Storage.update<TeamInfo>(configKey(teamName), (draft) => {
        const member = draft.members.find((m) => m.name === memberName)
        if (!member) return
        if (options?.guard && member.status === "shutdown") return
        const next = normalizeMember(member)
        const from = next.status
        if (!options?.force && !canTransition(from, status, MEMBER_TRANSITIONS)) return
        if (from === status) return
        const now = Date.now()
        agent = next.agent
        executionStatus = next.execution_status ?? "idle"
        runtime = next.started ? Math.max(0, now - next.started) : 0
        member.status = status
        member.updated = now
        if (status === "busy") {
          member.assigned_at = now
          if (next.worktreeBranch) {
            member.mergeStatus = "pending"
            delete member.mergeError
            delete member.mergedAt
          }
        }
        if (status !== "error") delete member.error_kind
        changed = true
      })
    } catch {
      return false
    }
    if (!changed) return false
    await Bus.publish(TeamEvent.MemberStatusChanged, { teamName, memberName, status })
    if (status === "ready") {
      await TeamPolicy.memberIdle({
        teamName,
        name: memberName,
        agent,
        executionStatus,
        runtime,
      })
      await checkBudget(teamName)
      const team = await get(teamName)
      const member = team?.members.find((item) => item.name === memberName)
      if (member?.status === "ready") {
        const { TeamMessaging } = await import("./messaging")
        await TeamMessaging.flush(teamName, memberName)
      }
    }
    return true
  }

  export async function transitionExecutionStatus(
    teamName: string,
    memberName: string,
    status: ExecutionStatusType,
    options?: { force?: boolean },
  ): Promise<boolean> {
    let changed = false
    try {
      await Storage.update<TeamInfo>(configKey(teamName), (draft) => {
        const member = draft.members.find((m) => m.name === memberName)
        if (!member) return
        const from = normalizeMember(member).execution_status ?? "idle"
        if (!options?.force && !canTransition(from, status, EXECUTION_TRANSITIONS)) return
        if (from === status) return
        const now = Date.now()
        member.execution_status = status
        member.updated = now
        if (status === "starting" || status === "running") member.started = now
        if (TERMINAL_EXECUTION_STATES.has(status)) delete member.started
        changed = true
      })
    } catch {
      return false
    }
    if (!changed) return false
    await Bus.publish(TeamEvent.MemberExecutionChanged, { teamName, memberName, status })
    return true
  }

  /**
   * Backward-compatible setter for tests and call sites that need direct status updates.
   */
  export async function setMemberStatus(
    teamName: string,
    memberName: string,
    status: MemberStatus,
    options?: { guard?: boolean },
  ): Promise<void> {
    await transitionMemberStatus(teamName, memberName, status, { guard: options?.guard, force: true })
  }

  /**
   * Toggle delegate mode on a team.
   */
  export async function setDelegate(teamName: string, delegate: boolean): Promise<void> {
    try {
      await Storage.update<TeamInfo>(configKey(teamName), (draft) => {
        draft.delegate = delegate
      })
    } catch {
      // Team not found — ignore
    }
  }

  /**
   * Update a member's plan approval status.
   */
  export async function setMemberPlanApproval(
    teamName: string,
    memberName: string,
    planApproval: "none" | "pending" | "approved" | "rejected",
  ): Promise<void> {
    try {
      await Storage.update<TeamInfo>(configKey(teamName), (draft) => {
        const member = draft.members.find((m) => m.name === memberName)
        if (!member) return
        member.planApproval = planApproval
      })
    } catch {
      // Team not found — ignore
    }
  }

  export async function setMemberCheckpoint(
    teamName: string,
    memberName: string,
    mode: CheckpointModeType,
  ): Promise<void> {
    try {
      await Storage.update<TeamInfo>(configKey(teamName), (draft) => {
        const member = draft.members.find((m) => m.name === memberName)
        if (!member) return
        member.checkpoint = mode
      })
    } catch {
      // Team not found — ignore
    }
  }

  export async function setMemberPhase(teamName: string, memberName: string, phase: MemberPhaseType): Promise<void> {
    try {
      await Storage.update<TeamInfo>(configKey(teamName), (draft) => {
        const member = draft.members.find((item) => item.name === memberName)
        if (!member) return
        member.phase = phase
        member.updated = Date.now()
      })
    } catch {
      // Team not found — ignore
    }
  }

  export async function setTeamPhase(teamName: string, phase: TeamPhaseLevelType): Promise<void> {
    let previous: TeamPhaseLevelType | undefined
    let changed = false
    try {
      await Storage.update<TeamInfo>(configKey(teamName), (draft) => {
        previous = TeamPhaseLevel.safeParse(draft.team_phase).success ? draft.team_phase : undefined
        if (previous === phase) return
        draft.team_phase = phase
        changed = true
      })
    } catch {
      return
    }
    if (!changed) return
    await Bus.publish(TeamEvent.TeamPhaseChanged, { teamName, phase, previous })
  }

  export async function setDelivered(teamName: string, delivered: boolean): Promise<void> {
    try {
      await Storage.update<TeamInfo>(configKey(teamName), (draft) => {
        draft.delivered = delivered
      })
    } catch {
      // Team not found — ignore
    }
  }

  export async function setMemberErrorKind(
    teamName: string,
    memberName: string,
    errorKind: TeamErrorKindType | undefined,
  ): Promise<void> {
    try {
      await Storage.update<TeamInfo>(configKey(teamName), (draft) => {
        const member = draft.members.find((item) => item.name === memberName)
        if (!member) return
        if (!errorKind) {
          delete member.error_kind
        } else {
          member.error_kind = errorKind
        }
        member.updated = Date.now()
      })
    } catch {
      // Team not found — ignore
    }
  }

  export async function setMemberMerge(
    teamName: string,
    memberName: string,
    input: {
      mergeStatus?: MergeStatusType
      mergeError?: string
      mergedAt?: number
    },
  ): Promise<void> {
    try {
      await Storage.update<TeamInfo>(configKey(teamName), (draft) => {
        const member = draft.members.find((item) => item.name === memberName)
        if (!member) return
        if (input.mergeStatus) member.mergeStatus = input.mergeStatus
        if (input.mergeError === undefined) delete member.mergeError
        else member.mergeError = input.mergeError
        if (input.mergedAt === undefined) delete member.mergedAt
        else member.mergedAt = input.mergedAt
        member.updated = Date.now()
      })
    } catch {
      // Team not found — ignore
    }
  }

  export async function setMemberResultAt(teamName: string, memberName: string, time: number): Promise<void> {
    try {
      await Storage.update<TeamInfo>(configKey(teamName), (draft) => {
        const member = draft.members.find((item) => item.name === memberName)
        if (!member) return
        member.last_result_at = time
        member.updated = Date.now()
      })
    } catch {
      // Team not found — ignore
    }
  }

  export async function setMemberAssignedAt(teamName: string, memberName: string, time: number): Promise<void> {
    try {
      await Storage.update<TeamInfo>(configKey(teamName), (draft) => {
        const member = draft.members.find((item) => item.name === memberName)
        if (!member) return
        member.assigned_at = time
        member.updated = Date.now()
      })
    } catch {
      // Team not found — ignore
    }
  }

  export async function bumpDelegations(teamName: string, memberName: string, delta: number): Promise<number> {
    let count = 0
    try {
      await Storage.update<TeamInfo>(configKey(teamName), (draft) => {
        const member = draft.members.find((item) => item.name === memberName)
        if (!member) return
        count = Math.max(0, (member.activeDelegations ?? 0) + delta)
        member.activeDelegations = count
      })
    } catch {
      return 0
    }
    return count
  }

  export async function setTrace(sessionID: string, trace: Trace): Promise<void> {
    const next = TraceSchema.parse(trace)
    cache().traces.set(sessionID, next)
    await Storage.write(traceKey(sessionID), next)
  }

  export async function trace(sessionID: string): Promise<Trace | undefined> {
    const hit = cache().traces.get(sessionID)
    if (hit) return hit
    try {
      const next = TraceSchema.parse(await Storage.read<Trace>(traceKey(sessionID)))
      cache().traces.set(sessionID, next)
      return next
    } catch {
      return undefined
    }
  }

  export async function clearTrace(sessionID: string): Promise<void> {
    cache().traces.delete(sessionID)
    await Storage.remove(traceKey(sessionID)).catch(() => {})
  }

  export async function listSpawnRequests(teamName: string): Promise<PendingSpawnRequest[]> {
    const team = await get(teamName)
    return team?.pending_spawn_requests ?? []
  }

  export async function getSpawnRequest(teamName: string, requestID: string): Promise<PendingSpawnRequest | undefined> {
    const team = await get(teamName)
    return team?.pending_spawn_requests?.find((item) => item.id === requestID)
  }

  export async function removeSpawnRequest(
    teamName: string,
    requestID: string,
  ): Promise<PendingSpawnRequest | undefined> {
    let found: PendingSpawnRequest | undefined
    try {
      await Storage.update<TeamInfo>(configKey(teamName), (draft) => {
        const list = draft.pending_spawn_requests ?? []
        const next = list.find((item) => item.id === requestID)
        if (!next) return
        found = PendingSpawnRequestSchema.parse(next)
        draft.pending_spawn_requests = list.filter((item) => item.id !== requestID)
      })
    } catch {
      return undefined
    }
    return found
  }

  export async function requestSpawn(input: {
    teamName: string
    requestedBy: string
    agent: string
    rationale: string
    name?: string
    prompt?: string
    messages: Array<{ info: { role: string; model?: { providerID: string; modelID: string } } }>
  }): Promise<
    | { status: "pending"; request: PendingSpawnRequest }
    | { status: "denied"; reason?: string }
    | { status: "approved"; request: PendingSpawnRequest; sessionID: string; label: string }
  > {
    const team = await get(input.teamName)
    if (!team) throw new Error(`Team "${input.teamName}" not found`)

    const request = PendingSpawnRequestSchema.parse({
      id: spawnRequestId(),
      requested_by: input.requestedBy,
      agent: input.agent,
      rationale: input.rationale,
      name: input.name,
      prompt: input.prompt,
      created: Date.now(),
    })

    const decision = await TeamPolicy.spawnRequested({
      teamName: input.teamName,
      requestedBy: input.requestedBy,
      agent: input.agent,
      rationale: input.rationale,
    })

    if (decision.action === "deny") {
      return { status: "denied", reason: decision.reason }
    }

    if (decision.action === "approve") {
      const { Agent } = await import("./runtime")
      const agent = await Agent.get(input.agent)
      if (!agent || agent.mode === "primary" || agent.hidden === true) {
        throw new Error(`Agent "${input.agent}" not found.`)
      }
      const model = await resolveModel({ agent, messages: input.messages })
      if ("error" in model) throw new Error(model.error)
      const spawned = await spawnMember({
        teamName: input.teamName,
        name: request.name ?? `${input.agent}-${request.id.slice(-4)}`,
        parentSessionID: team.leadSessionID,
        requestedBy: input.requestedBy,
        agent,
        model,
        prompt:
          request.prompt ??
          [`You were requested by teammate "${input.requestedBy}".`, `Rationale: ${input.rationale}`].join("\n"),
        planApproval: false,
        checkpoint: "none",
      })
      return { status: "approved", request, sessionID: spawned.sessionID, label: spawned.label }
    }

    await Storage.update<TeamInfo>(configKey(input.teamName), (draft) => {
      draft.pending_spawn_requests = [...(draft.pending_spawn_requests ?? []), request]
    })
    await Bus.publish(TeamEvent.SpawnRequested, { teamName: input.teamName, request })
    return { status: "pending", request }
  }

  export async function rejectSpawnRequest(input: {
    teamName: string
    requestID: string
    reason?: string
  }): Promise<PendingSpawnRequest> {
    const request = await removeSpawnRequest(input.teamName, input.requestID)
    if (!request) throw new Error(`Spawn request "${input.requestID}" not found.`)
    return request
  }

  /**
   * Remove a member from a team.
   */
  export async function removeMember(teamName: string, memberName: string): Promise<void> {
    let sessionID: string | undefined
    try {
      await Storage.update<TeamInfo>(configKey(teamName), (draft) => {
        sessionID = draft.members.find((m) => m.name === memberName)?.sessionID
        draft.members = draft.members.filter((m) => m.name !== memberName)
      })
    } catch {
      // Team not found — ignore
    }
    if (sessionID) {
      cache().links.delete(sessionID)
      await removeSessionMeta(sessionID)
    }
    log.info("member removed", { teamName, memberName })
  }

  /**
   * Find which team a session belongs to (as lead or member).
   */
  export async function findBySession(
    sessionID: string,
  ): Promise<{ team: TeamInfo; role: "lead" | "member"; memberName?: string } | undefined> {
    const hit = cache().links.get(sessionID)
    if (hit) return await resolveLink(sessionID, hit)
    await hydrateLinks()
    const next = cache().links.get(sessionID)
    if (!next) return undefined
    return await resolveLink(sessionID, next)
  }

  /**
   * Resolve the model for a teammate.
   * Priority: explicit model param > agent model > lead's last model > global default.
   * Returns `{ error }` if the explicit model is not found.
   */
  export async function resolveModel(input: {
    model?: string
    agent: { model?: { providerID: string; modelID: string } }
    messages: Array<{ info: { role: string; model?: { providerID: string; modelID: string } } }>
  }): Promise<{ providerID: string; modelID: string } | { error: string }> {
    const { Provider } = await import("./runtime")
    const { ProviderID, ModelID } = await import("../provider/schema")

    async function known(model: { providerID: string; modelID: string }) {
      try {
        await Provider.getModel(ProviderID.make(model.providerID), ModelID.make(model.modelID))
        return true
      } catch (e: unknown) {
        if (Provider.ModelNotFoundError.isInstance(e)) return false
        throw e
      }
    }

    if (input.model) {
      const parsed = Provider.parseModel(input.model)
      try {
        await Provider.getModel(parsed.providerID, parsed.modelID)
      } catch (e: unknown) {
        if (Provider.ModelNotFoundError.isInstance(e)) {
          const hint = e.data.suggestions?.length ? ` Did you mean: ${e.data.suggestions.join(", ")}?` : ""
          return { error: `Model not found: ${input.model}.${hint}` }
        }
        throw e
      }
      return parsed
    }
    if (input.agent.model && (await known(input.agent.model))) return input.agent.model
    const lastUser = input.messages.findLast((m) => m.info.role === "user")
    if (lastUser?.info.model && (await known(lastUser.info.model))) return lastUser.info.model
    return await Provider.defaultModel()
  }

  /**
   * Get cumulative token/cost data for the entire team (lead + all members).
   */
  export async function cost(teamName: string): Promise<{
    total: { input: number; output: number; reasoning: number; cost: number }
    perMember: Record<string, { input: number; output: number; reasoning: number; cost: number }>
  }> {
    const { Session } = await import("./runtime")
    const { SessionID } = await import("../session/schema")

    const team = await get(teamName)
    if (!team) return { total: { input: 0, output: 0, reasoning: 0, cost: 0 }, perMember: {} }

    const result: Record<string, { input: number; output: number; reasoning: number; cost: number }> = {}

    const ids = new Set([team.leadSessionID, ...team.members.map((member) => member.sessionID)])
    const seen = new Map<string, { input: number; output: number; reasoning: number; cost: number }>()

    async function sum(sessionID: string) {
      const cached = seen.get(sessionID)
      if (cached) return cached
      const acc = { input: 0, output: 0, reasoning: 0, cost: 0 }
      const msgs = await Session.messages({ sessionID: SessionID.make(sessionID) }).catch(() => [])
      for (const m of msgs) {
        if (m.info.role !== "assistant") continue
        const a = m.info as { tokens: { input: number; output: number; reasoning: number }; cost: number }
        acc.input += a.tokens.input
        acc.output += a.tokens.output
        acc.reasoning += a.tokens.reasoning
        acc.cost += a.cost
      }
      const kids = await Session.children(SessionID.make(sessionID)).catch(() => [])
      for (const child of kids) {
        if (ids.has(child.id)) continue
        const next = await sum(child.id)
        acc.input += next.input
        acc.output += next.output
        acc.reasoning += next.reasoning
        acc.cost += next.cost
      }
      seen.set(sessionID, acc)
      return acc
    }

    result.lead = await sum(team.leadSessionID)
    for (const member of team.members) {
      result[member.name] = await sum(member.sessionID)
    }

    const total = { input: 0, output: 0, reasoning: 0, cost: 0 }
    for (const v of Object.values(result)) {
      total.input += v.input
      total.output += v.output
      total.reasoning += v.reasoning
      total.cost += v.cost
    }

    return { total, perMember: result }
  }

  /**
   * Spawn a teammate — creates session, registers member, starts prompt loop.
   * On addMember failure, cleans up the orphaned session.
   */
  export async function spawnMember(input: {
    teamName: string
    name: string
    parentSessionID: string
    requestedBy?: string
    agent: { name: string; prompt?: string; skills?: string[] }
    model: { providerID: string; modelID: string }
    prompt: string
    claimTask?: string
    planApproval: boolean
    checkpoint: CheckpointModeType
    timeout?: number
    maxCost?: number
    maxTokens?: number
    scope?: TeamScopeType
    mode?: TeamModeType
    resultDeadline?: number
  }): Promise<{ sessionID: string; label: string }> {
    const { Session } = await import("./runtime")
    const { SessionPrompt } = await import("./runtime")
    const { Instance: Inst } = await import("../project/instance")

    const label = `${input.model.providerID}/${input.model.modelID}`
    const team = await get(input.teamName)
    if (!team) throw new Error(`Team "${input.teamName}" not found`)

    const spawn = await TeamPolicy.memberSpawning({
      teamName: input.teamName,
      name: input.name,
      agent: input.agent.name,
      model: label,
      requestedBy: input.requestedBy ?? "lead",
      currentMemberCount: team.members.length,
    })
    if (!spawn.allow) {
      throw new Error(spawn.reason ?? `Spawning teammate "${input.name}" was denied by team policy.`)
    }

    const scope = TeamScope.withDefaults(TeamScope.merge(team.scope, input.scope))
    const { TeamWorktree } = await import("./worktree")
    const { Project } = await import("./runtime")
    const tree = team.worktrees
      ? await TeamWorktree.create({
          repoDir: Inst.directory,
          teamName: input.teamName,
          memberName: input.name,
          projectID: Inst.project.id,
        }).then(async (tree) => {
          if (!tree) return tree
          try {
            await Project.addSandbox(Inst.project.id, tree.path)
            return tree
          } catch (err) {
            await TeamWorktree.remove({
              repoDir: Inst.directory,
              worktreePath: tree.path,
              branch: tree.branch,
            }).catch(() => undefined)
            throw err
          }
        })
      : null
    if (team.worktrees && !tree) {
      log.warn("team worktree unavailable, falling back to shared directory", {
        teamName: input.teamName,
        memberName: input.name,
        directory: Inst.directory,
      })
    }

    // Build permission rules for the child session.
    // Deny lead-only tools, and explicitly allow all other team tools so that
    // restrictive agents (those with "*": "deny") don't accidentally block
    // team communication — session-level allows override agent-level denies
    // because Permission.disabled() uses findLast and session rules come last.
    const rules: Rule[] = [
      ...TEAM_LEAD_ONLY_IDS.map((tool) => ({
        permission: tool,
        pattern: "*",
        action: "deny" as const,
      })),
      ...TEAM_MEMBER_ALLOWED_IDS.map((tool) => ({
        permission: tool,
        pattern: "*",
        action: "allow" as const,
      })),
    ]
    rules.push(...scopeRules(scope, tree?.path ?? Inst.directory))
    if (tree) {
      rules.push({
        permission: "external_directory",
        pattern: permGlob(tree.path),
        action: "allow",
      })
    }
    if (input.mode === "research") {
      rules.push(...lockRules("*:research-mode"))
    }
    if (input.planApproval) {
      // Pattern "*:plan-approval" is intentionally NOT "*" — PermissionNext.disabled() only
      // strips tools with pattern "*", so these remain visible to the model but are denied at
      // execution time. The ":plan-approval" tag lets approvePlan() remove only these rules.
      rules.push(...lockRules("*:plan-approval"))
    }

    const { SessionID } = await import("../session/schema")
    const session = await Session.createNext({
      parentID: SessionID.make(input.parentSessionID),
      directory: tree?.path ?? Inst.directory,
      title: `${input.name} (@${input.agent.name} teammate, ${label})${input.planApproval ? " [plan mode]" : ""}`,
      permission: await childPermission(input.parentSessionID, rules),
    }).catch(async (err: unknown) => {
      if (tree) {
        await Project.removeSandbox(Inst.project.id, tree.path).catch(() => undefined)
        await TeamWorktree.remove({
          repoDir: Inst.directory,
          worktreePath: tree.path,
          branch: tree.branch,
        }).catch(() => undefined)
      }
      throw err
    })

    // Register member — if this fails, clean up the orphaned session
    try {
      await writeSessionMeta(session.id, {
        name: input.name,
        teamName: input.teamName,
        agent: input.agent.name,
        model: label,
        prompt: input.prompt,
      })
      await addMember(input.teamName, {
        name: input.name,
        sessionID: session.id,
        agent: input.agent.name,
        status: "busy",
        execution_status: "idle",
        updated: Date.now(),
        prompt: input.prompt,
        model: label,
        planApproval: input.planApproval ? "pending" : "none",
        checkpoint: input.checkpoint,
        activeDelegations: 0,
        maxCost: input.maxCost,
        worktreePath: tree?.path,
        worktreeBranch: tree?.branch,
        mergeStatus: tree?.branch ? "pending" : undefined,
        scope,
        mode: input.mode ?? "mixed",
        result_deadline: input.resultDeadline,
      })
    } catch (err) {
      // Orphaned session cleanup
      try {
        await Session.remove(session.id)
      } catch {
        log.warn("failed to clean up orphaned session", { sessionID: session.id })
      }
      await removeSessionMeta(session.id)
      if (tree) {
        await Project.removeSandbox(Inst.project.id, tree.path).catch(() => undefined)
        await TeamWorktree.remove({
          repoDir: Inst.directory,
          worktreePath: tree.path,
          branch: tree.branch,
        }).catch(() => undefined)
      }
      throw err
    }

    if (input.claimTask) {
      await TeamTasks.claim(input.teamName, input.claimTask, input.name).catch(() => {})
    }

    // Build teammate context message
    const planInstructions = input.planApproval
      ? [
          "",
          "IMPORTANT: You are in PLAN MODE (read-only). You can read files, search, and explore,",
          "but you CANNOT write, edit, run bash commands, or spawn child subagents until the lead approves your plan.",
          "",
          "Your workflow:",
          "1. Research and explore the codebase to understand the problem",
          "2. Formulate a detailed implementation plan",
          "3. Send your plan to the lead using team_message (to: 'lead')",
          "4. Wait for the lead to approve your plan (you'll receive a message when approved)",
          "5. Once approved, your write permissions will be unlocked and you can implement",
          "",
        ]
      : []

    const checkpointInstructions =
      input.checkpoint !== "none"
        ? [
            "",
            `CHECKPOINT MODE: The system will pause you ${checkpointText(input.checkpoint)} for lead review.`,
            "When resumed, review the latest team message and continue from there.",
            "",
          ]
        : []

    const modeInstructions =
      input.mode === "research"
        ? [
            "",
            "RESEARCH MODE: You are read-only.",
            "Do not write files, edit code, run bash commands, or spawn child subagents. Focus on investigation and reporting.",
            "",
          ]
        : []

    const deadlineInstructions = input.resultDeadline
      ? [
          "",
          `RESULT DEADLINE: You must submit your final structured result within ${input.resultDeadline} minute(s) using team_submit_result.`,
          "",
        ]
      : []

    const skillContext = input.agent.skills?.length
      ? [
          "",
          `Preloaded skills: ${input.agent.skills.join(", ")}`,
          "These skills are already loaded into your context — you do not need to invoke the skill tool for them.",
          "",
        ]
      : []

    // Gather team state for context injection
    const { TeamNotepad } = await import("./notepad")
    const notepadCtx = await TeamNotepad.context(input.teamName).catch(() => "")
    const state = await get(input.teamName)
    const tasks = await TeamTasks.list(input.teamName)

    const otherMembers = state?.members.filter((m) => m.name !== input.name && m.status !== "shutdown") ?? []
    const peerList =
      otherMembers.length > 0
        ? ["Other active teammates:", ...otherMembers.map((m) => `  - ${m.name} (@${m.agent}): ${m.status}`), ""]
        : []

    const taskSummary =
      tasks.length > 0
        ? [
            "Current task board:",
            ...tasks.map((t) => `  [${t.id}] ${t.content} — ${t.status}${t.assignee ? ` (${t.assignee})` : ""}`),
            "",
          ]
        : []

    const budgetInfo =
      input.timeout || input.maxTokens
        ? [
            "Budget constraints:",
            ...(input.timeout ? [`  - Time limit: ${input.timeout} minutes`] : []),
            ...(input.maxCost ? [`  - Cost limit: $${input.maxCost.toFixed(2)}`] : []),
            ...(input.maxTokens ? [`  - Token budget: ${input.maxTokens} tokens`] : []),
            "",
          ]
        : []

    const context = [
      `You are "${input.name}", a teammate in team "${input.teamName}".`,
      `Your agent type is "${input.agent.name}", using model ${label}.`,
      "",
      "Team tools available to you:",
      "- team_message: send a message to the lead or another teammate",
      "- team_reply: reply to the most recent team message with thread context",
      "- team_broadcast: send a message to all teammates",
      "- team_request_spawn: ask the lead to add another specialist when needed",
      "- team_delegate: run a lightweight child subagent and get the result back privately",
      "- team_inbox: read your inbox or flush undelivered team messages",
      "- team_submit_result: send a structured task result to the lead",
      "- team_wait: check if a team condition has been met without blocking",
      "- team_collect: wait for teammate results before synthesizing",
      "- team_tasks: view/add/complete tasks on the shared task list",
      "- team_claim: claim a pending task from the shared task list",
      "- team_notepad: read/write shared team knowledge",
      "- team_phase: report your current work phase to the lead",
      "- team_status: see full team state",
      "- team_health: diagnose stuck members or blocked tasks",
      "- team_shutdown_all: request shutdown for every active teammate",
      "- team_restart: re-engage an idle or errored teammate",
      "",
      "You do NOT have access to team_create, team_spawn, team_shutdown, team_merge, team_cleanup, or team_approve_plan.",
      "Only the team lead can manage the team structure and approve plans.",
      ...skillContext,
      ...planInstructions,
      ...modeInstructions,
      ...checkpointInstructions,
      ...deadlineInstructions,
      ...peerList,
      ...taskSummary,
      ...budgetInfo,
      ...(notepadCtx ? [notepadCtx] : []),
      "You MUST use team_submit_result to send a structured report to the lead when you finish. This is REQUIRED.",
      "Use team_message for follow-ups, questions, and coordination that are not final task results.",
      "You can message any teammate by name — not just the lead. Coordinate directly with peers when useful.",
      "When reviews overlap, compare notes with peers, help unblock each other, and work toward a shared conclusion before final reporting.",
      "",
      "SUBAGENT RELAY: If you use the task tool to spawn subagents, they CANNOT communicate with the team.",
      "You are responsible for relaying any relevant subagent findings via team_message or team_broadcast.",
      "",
      "IMPORTANT: Your plain text output is NOT visible to the team lead or other teammates.",
      "You MUST use team_message or team_broadcast to communicate. Just typing a response is not enough.",
      "",
      "Your instructions:",
      input.prompt,
    ].join("\n")

    const { MessageID, PartID } = await import("../session/schema")
    const { ProviderID, ModelID } = await import("../provider/schema")
    const msgId = MessageID.ascending()
    await Session.updateMessage({
      id: msgId,
      sessionID: session.id,
      role: "user",
      agent: input.agent.name,
      model: {
        providerID: ProviderID.make(input.model.providerID),
        modelID: ModelID.make(input.model.modelID),
      },
      time: { created: Date.now() },
    })
    await Session.updatePart({
      id: PartID.ascending(),
      messageID: msgId,
      sessionID: session.id,
      type: "text",
      text: context,
    })

    await transitionMemberStatus(input.teamName, input.name, "busy")
    await transitionExecutionStatus(input.teamName, input.name, "starting")

    // Fire-and-forget the teammate's prompt loop.
    // Wrapped in Promise.resolve().then() to guard against synchronous throws.
    log.info("spawning teammate", { teamName: input.teamName, name: input.name, sessionID: session.id })

    // Timeout enforcement: cancel the teammate if they exceed the time limit
    const timeoutMs = input.timeout ? input.timeout * 60 * 1000 : undefined
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    if (timeoutMs) {
      timeoutHandle = setTimeout(async () => {
        log.warn("teammate timeout", { teamName: input.teamName, name: input.name, timeout: input.timeout })
        await transitionExecutionStatus(input.teamName, input.name, "timed_out")
        await transitionMemberStatus(input.teamName, input.name, "error", { force: true })
        await setMemberErrorKind(input.teamName, input.name, "timeout")
        await SessionPrompt.cancel(session.id)
        await Bus.publish(TeamEvent.MemberTimeout, {
          teamName: input.teamName,
          memberName: input.name,
          elapsed: timeoutMs,
          limit: timeoutMs,
        })
        const { TeamMessaging: TM } = await import("./messaging")
        await TM.send({
          teamName: input.teamName,
          from: input.name,
          to: "lead",
          text: `I was automatically timed out after ${input.timeout} minutes. Review my session (${session.id}) for partial results.`,
        }).catch(() => {})
      }, timeoutMs)
    }

    if (input.resultDeadline) {
      const deadlineMs = input.resultDeadline * 60 * 1000
      const warnAt = Math.max(deadlineMs - 5 * 60_000, deadlineMs * 0.75)

      setTimeout(async () => {
        const member = (await get(input.teamName))?.members.find((item) => item.name === input.name)
        if (!member || member.status === "shutdown" || member.last_result_at) return
        const { TeamMessaging } = await import("./messaging")
        await TeamMessaging.send({
          teamName: input.teamName,
          from: "system",
          to: input.name,
          text: "DEADLINE WARNING: Submit your result NOW using team_submit_result.",
          priority: "urgent",
        }).catch(() => {})
      }, warnAt)

      setTimeout(async () => {
        const member = (await get(input.teamName))?.members.find((item) => item.name === input.name)
        if (!member || member.status === "shutdown" || member.last_result_at) return
        const { TeamMessaging } = await import("./messaging")
        await TeamMessaging.send({
          teamName: input.teamName,
          from: "system",
          to: "lead",
          text: `DEADLINE EXPIRED: "${input.name}" did not submit within ${input.resultDeadline} min.`,
          priority: "urgent",
        }).catch(() => {})
      }, deadlineMs)
    }

    Promise.resolve()
      .then(async () => {
        await transitionExecutionStatus(input.teamName, input.name, "running")
        return SessionPrompt.loop({ sessionID: session.id })
      })
      .then(async () => {
        if (timeoutHandle) clearTimeout(timeoutHandle)
        log.info("teammate loop ended", { teamName: input.teamName, name: input.name })
        await transitionExecutionStatus(input.teamName, input.name, "completing")
        await transitionExecutionStatus(input.teamName, input.name, "completed")
        await transitionExecutionStatus(input.teamName, input.name, "idle")
        const team = await get(input.teamName)
        const member = team?.members.find((m) => m.name === input.name)
        if (member?.status === "shutdown_requested") {
          await transitionMemberStatus(input.teamName, input.name, "shutdown")
        } else if (member?.status === "paused") {
          log.info("teammate loop paused", { teamName: input.teamName, name: input.name })
        } else {
          await transitionMemberStatus(input.teamName, input.name, "ready")
        }
        await notifyLead(input.teamName, input.name, session.id, "completed")
      })
      .catch(async (err) => {
        if (timeoutHandle) clearTimeout(timeoutHandle)
        const msg = err instanceof Error ? err.message : String(err)
        log.warn("teammate loop error", { teamName: input.teamName, name: input.name, error: msg })

        const team = await get(input.teamName)
        const member = team?.members.find((item) => item.name === input.name)
        if (member?.execution_status === "timed_out") {
          await setMemberErrorKind(input.teamName, input.name, "timeout")
          await transitionMemberStatus(input.teamName, input.name, "error", { force: true })
          await notifyLead(input.teamName, input.name, session.id, "errored", msg)
          return
        }

        await transitionExecutionStatus(input.teamName, input.name, "failed")
        await transitionExecutionStatus(input.teamName, input.name, "idle")
        await setMemberErrorKind(input.teamName, input.name, "member_crashed")
        await transitionMemberStatus(input.teamName, input.name, "error")
        await notifyLead(input.teamName, input.name, session.id, "errored", msg)
      })

    await TeamPolicy.memberSpawned({
      teamName: input.teamName,
      name: input.name,
      agent: input.agent.name,
      sessionID: session.id,
    })

    return { sessionID: session.id, label }
  }

  /**
   * Approve or reject a teammate's plan. On approval, removes plan-approval
   * deny rules and notifies the teammate.
   */
  export async function approvePlan(input: {
    teamName: string
    memberName: string
    approved: boolean
    feedback?: string
  }): Promise<void> {
    const { Session } = await import("./runtime")
    const { TeamMessaging } = await import("./messaging")

    const team = await get(input.teamName)
    if (!team) throw new Error(`Team "${input.teamName}" not found`)

    const member = team.members.find((m) => m.name === input.memberName)
    if (!member) throw new Error(`Teammate "${input.memberName}" not found`)

    if (input.approved) {
      const { SessionID } = await import("../session/schema")
      const session = await Session.get(SessionID.make(member.sessionID))
      if (session.permission) {
        await Session.setPermission({
          sessionID: SessionID.make(member.sessionID),
          permission: session.permission.filter((rule) => rule.pattern !== "*:plan-approval"),
        })
      }
      await setMemberPlanApproval(input.teamName, input.memberName, "approved")
      await TeamMessaging.send({
        teamName: input.teamName,
        from: "lead",
        to: input.memberName,
        text: input.feedback
          ? `Your plan has been APPROVED. You now have full write access. Feedback: ${input.feedback}`
          : "Your plan has been APPROVED. You now have full write access. Proceed with implementation.",
      })
    } else {
      await setMemberPlanApproval(input.teamName, input.memberName, "rejected")
      await TeamMessaging.send({
        teamName: input.teamName,
        from: "lead",
        to: input.memberName,
        text: `Your plan has been REJECTED. Please revise and resubmit. Feedback: ${input.feedback ?? "No specific feedback provided."}`,
      })
    }

    await Bus.publish(TeamEvent.PlanApproval, {
      teamName: input.teamName,
      memberName: input.memberName,
      approved: input.approved,
      feedback: input.feedback,
    })
  }

  export async function restart(input: { teamName: string; memberName: string; text: string }): Promise<void> {
    const { TeamMessaging } = await import("./messaging")

    const team = await get(input.teamName)
    if (!team) throw new Error(`Team "${input.teamName}" not found`)

    const member = team.members.find((m) => m.name === input.memberName)
    if (!member) throw new Error(`Teammate "${input.memberName}" not found`)
    if (member.status !== "ready" && member.status !== "error") {
      throw state(`Teammate "${input.memberName}" is ${member.status} — can only restart ready or errored teammates.`)
    }

    await TeamMessaging.send({
      teamName: input.teamName,
      from: "lead",
      to: input.memberName,
      text: input.text,
    })

    if (member.status === "error") {
      await transitionMemberStatus(input.teamName, input.memberName, "ready", { force: true })
    }
  }

  export async function shutdown(input: {
    teamName: string
    memberName: string
    reason?: string
  }): Promise<
    | { status: "not_found" }
    | { status: "already_shutdown" }
    | { status: "blocked"; reason?: string }
    | { status: "requested" }
  > {
    const { TeamMessaging } = await import("./messaging")
    const { Inbox } = await import("./inbox")
    const { SessionPrompt } = await import("./runtime")
    const { SessionID } = await import("../session/schema")

    const team = await get(input.teamName)
    const member = team?.members.find((item) => item.name === input.memberName)
    if (!team || !member) return { status: "not_found" }
    if (member.status === "shutdown") return { status: "already_shutdown" }

    const tasks = await TeamTasks.list(input.teamName)
    const mark = member.assigned_at ?? 0
    const open = tasks.filter((task) => task.assignee === input.memberName && task.status === "in_progress").length
    const mail = await Inbox.all(input.teamName, "lead").catch(() => [])
    const fresh =
      (typeof member.last_result_at === "number" && member.last_result_at >= mark) ||
      mail.some(
        (item) =>
          item.from === input.memberName &&
          (item.type === "result" || !!item.metadata?.result) &&
          item.timestamp >= mark,
      )
    if (team.require_result_before_shutdown && open > 0 && !fresh) {
      return {
        status: "blocked",
        reason: `Team policy requires a submitted result before shutting down "${input.memberName}" while assigned work is still in progress.`,
      }
    }
    const guard = await TeamPolicy.shutdownBefore({
      teamName: input.teamName,
      name: input.memberName,
      tasksRemaining: tasks.filter(
        (task) => task.assignee === input.memberName && task.status !== "completed" && task.status !== "cancelled",
      ).length,
      tasksInProgress: open,
      requireResult: team.require_result_before_shutdown ?? false,
      hasResult: fresh,
    })
    if (!guard.allow) {
      return {
        status: "blocked",
        reason: guard.reason ?? `Team policy blocked shutdown for "${input.memberName}".`,
      }
    }

    const status = member.status
    await transitionMemberStatus(input.teamName, input.memberName, "shutdown_requested")
    await Bus.publish(TeamEvent.ShutdownRequest, {
      teamName: input.teamName,
      memberName: input.memberName,
    })

    const sent = await TeamMessaging.send({
      teamName: input.teamName,
      from: "lead",
      to: input.memberName,
      text: [
        `SHUTDOWN REQUEST: ${input.reason ?? "The lead has requested you shut down."}`,
        "",
        "Please wrap up your current work:",
        "1. Summarize your findings and send them to the lead.",
        "2. Stop working after sending your summary.",
      ].join("\n"),
    }).then(
      () => true,
      async () => {
        await SessionPrompt.cancel(SessionID.make(member.sessionID))
        const ok = (await Team.cancelMember(input.teamName, input.memberName)) || (await stopped(member.sessionID))
        if (ok) {
          await transitionMemberStatus(input.teamName, input.memberName, "shutdown")
        }
        return false
      },
    )

    if (status === "busy") {
      await Team.cancelMember(input.teamName, input.memberName)
    }

    if (sent) {
      await wake(input.teamName, input.memberName, member.sessionID)
      timeout(input.teamName, input.memberName, member.sessionID)
    }

    return { status: "requested" }
  }

  export async function steer(input: {
    teamName: string
    memberName: string
    text: string
  }): Promise<"restart" | "resume" | "message"> {
    const { TeamMessaging } = await import("./messaging")

    const team = await get(input.teamName)
    if (!team) throw new Error(`Team "${input.teamName}" not found`)

    const member = team.members.find((m) => m.name === input.memberName)
    if (!member) throw new Error(`Teammate "${input.memberName}" not found`)

    if (member.status === "shutdown" || member.status === "shutdown_requested") {
      throw state(`Teammate "${input.memberName}" cannot be steered from status ${member.status}.`)
    }

    if (member.status === "ready" || member.status === "error") {
      await restart(input)
      return "restart"
    }

    if (member.status === "paused") {
      await resume({
        teamName: input.teamName,
        memberName: input.memberName,
        redirect: input.text,
      })
      return "resume"
    }

    if (member.status !== "busy") {
      throw state(`Teammate "${input.memberName}" cannot be steered from status ${member.status}.`)
    }

    await TeamMessaging.send({
      teamName: input.teamName,
      from: "lead",
      to: input.memberName,
      text: input.text,
    })
    return "message"
  }

  export async function steerAll(input: { teamName: string; text: string }) {
    const { TeamMessaging } = await import("./messaging")
    const team = await get(input.teamName)
    if (!team) throw new Error(`Team "${input.teamName}" not found`)
    return TeamMessaging.broadcast({
      teamName: input.teamName,
      from: "lead",
      text: input.text,
      targets: team.members
        .filter((member) => member.status === "ready" || member.status === "busy" || member.status === "error")
        .map((member) => member.name),
    })
  }

  /**
   * Notify the lead that a teammate's loop finished or errored.
   * Uses guard option because the lead may have already sent a shutdown request
   * (setting status to "shutdown") while the loop was finishing — without guard,
   * this would overwrite "shutdown" with "ready", preventing auto-cleanup.
   */
  async function notifyLead(
    teamName: string,
    name: string,
    sessionID: string,
    status: "completed" | "cancelled" | "errored",
    error?: string,
  ) {
    try {
      const { TeamMessaging } = await import("./messaging")

      const team = await get(teamName)
      if (!team) return

      const member = team.members.find((m) => m.name === name)
      if (member?.status === "shutdown") return

      const text =
        status === "cancelled"
          ? `I was interrupted by the lead and am now idle. Send me a message to resume work.`
          : status === "completed"
            ? `I have finished my current work and am now idle. Review my session (${sessionID}) for detailed results. You can use team_shutdown to shut me down if no more work is needed.`
            : `I encountered an error and stopped: ${error ?? "unknown error"}. Review my session (${sessionID}). You can use team_shutdown to shut me down, or send me a message to retry.`

      await TeamMessaging.send({
        teamName,
        from: name,
        to: "lead",
        text,
        metadata: { completionStatus: status },
      })
    } catch (err: unknown) {
      log.warn("failed to notify lead of teammate completion", {
        teamName,
        name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Merge teammate worktree branches into the lead branch.
   */
  export async function merge(
    teamName: string,
    memberName?: string,
    action?: "merge" | "continue" | "abort" | "mark_resolved",
  ): Promise<{
    merged: string[]
    skipped: string[]
    conflicts: Array<{ name: string; error: string; files: string[] }>
    pending: string[]
  }> {
    const team = await get(teamName)
    if (!team) throw new Error(`Team "${teamName}" not found`)
    if (!team.worktrees) throw new Error(`Team "${teamName}" is not using worktrees.`)
    const { TeamMerge } = await import("./merge")
    return TeamMerge.merge({
      action,
      team,
      repoDir: await leadDir(team.leadSessionID),
      memberName,
    })
  }

  /**
   * Clean up a team — removes config and task data.
   * Fails if any members are still active.
   * Publishes TeamEvent.Cleaned so listeners can handle side-effects
   * (e.g. restoring lead session permissions).
   */
  export async function cleanup(teamName: string): Promise<void> {
    const key = `${Instance.project.id}:${teamName}`
    if (cleaning.has(key)) {
      throw new Error(`Team "${teamName}" cleanup already in progress.`)
    }
    cleaning.add(key)

    try {
      const team = await get(teamName)
      if (!team) throw new Error(`Team "${teamName}" not found`)

      const alive = team.members.filter((m) => m.status !== "shutdown")
      if (alive.length > 0) {
        throw new Error(
          `Cannot clean up team "${teamName}": ${alive.length} non-shutdown member(s): ${alive.map((m) => m.name).join(", ")}. Shut them down first.`,
        )
      }

      const running: typeof team.members = []
      const state = await Promise.all(team.members.map((member) => stopped(member.sessionID)))
      for (const [idx, ok] of state.entries()) {
        if (ok) continue
        const member = team.members[idx]
        if (member) running.push(member)
      }
      const active = running.map((member) => member.name)
      if (active.length > 0) {
        throw new Error(
          `Cannot clean up team "${teamName}": ${active.join(", ")} still have active session loops. Wait for prompt shutdown acknowledgement first.`,
        )
      }

      const trees = team.members.filter((member) => member.worktreePath && member.worktreeBranch)
      if (team.worktrees) {
        const pending = trees.filter((member) => !["merged", "skipped"].includes(member.mergeStatus ?? "pending"))
        if (pending.length > 0) {
          throw new Error(
            `Cannot clean up team "${teamName}": run team_merge first for ${pending.map((member) => member.name).join(", ")}.`,
          )
        }
      }

      const { Inbox } = await import("./inbox")
      const { TeamNotepad } = await import("./notepad")
      const { removeEdits } = await import("./files")
      const { TeamWorktree } = await import("./worktree")
      const { Project } = await import("./runtime")
      const repoDir = await leadDir(team.leadSessionID)
      await Inbox.removeAll(
        teamName,
        team.members.map((m) => m.name),
      )
      await TeamNotepad.removeAll(teamName)
      removeEdits(teamName)
      for (const member of trees) {
        await Project.removeSandbox(Instance.project.id, member.worktreePath!).catch(() => undefined)
        await TeamWorktree.remove({
          repoDir,
          worktreePath: member.worktreePath!,
          branch: member.worktreeBranch!,
        })
      }
      await Storage.remove(configKey(teamName))
      await Storage.remove(tasksKey(teamName))
      dropTeam(team)
      for (const member of team.members) {
        await removeSessionMeta(member.sessionID)
      }
      log.info("team cleaned up", { teamName })
      await Bus.publish(TeamEvent.Cleaned, {
        teamName,
        leadSessionID: team.leadSessionID,
        delegate: !!team.delegate,
      })
    } finally {
      cleaning.delete(key)
    }
  }

  async function interrupt(teamName: string, memberName: string, keep: boolean): Promise<boolean> {
    const { SessionPrompt } = await import("./runtime")
    const { SessionStatus } = await import("./runtime")
    const { SessionID } = await import("../session/schema")

    const team = await get(teamName)
    if (!team) return false

    const member = team.members.find((m) => m.name === memberName)
    if (!member) return false
    if (TERMINAL_EXECUTION_STATES.has(member.execution_status ?? "idle")) return false

    log.info("cancelling member", { teamName, memberName, sessionID: member.sessionID })
    await transitionExecutionStatus(teamName, memberName, "cancel_requested")

    const sid = SessionID.make(member.sessionID)
    for (const _ of [0, 1, 2]) {
      await SessionPrompt.cancel(sid)
      await transitionExecutionStatus(teamName, memberName, "cancelling")
      await Bun.sleep(120)
      const next = await get(teamName)
      const current = next?.members.find((m) => m.name === memberName)
      if (!current) break
      if (TERMINAL_EXECUTION_STATES.has(current.execution_status ?? "idle")) break
    }

    const next = await get(teamName)
    const current = next?.members.find((m) => m.name === memberName)
    if (!current) return true
    if (TERMINAL_EXECUTION_STATES.has(current.execution_status ?? "idle")) return true

    const runtime = await SessionStatus.get(sid)
    if (runtime.type !== "idle") return false

    await transitionExecutionStatus(teamName, memberName, "cancelled", { force: true })
    await transitionExecutionStatus(teamName, memberName, "idle", { force: true })
    if (!keep && current.status === "busy") {
      await transitionMemberStatus(teamName, memberName, "ready", { force: true })
    }
    return true
  }

  export async function pause(input: { teamName: string; memberName: string; reason?: string }): Promise<void> {
    const team = await get(input.teamName)
    if (!team) throw new Error(`Team "${input.teamName}" not found`)

    const member = team.members.find((m) => m.name === input.memberName)
    if (!member) throw new Error(`Teammate "${input.memberName}" not found`)
    if (member.status === "paused") return
    if (member.status === "shutdown" || member.status === "shutdown_requested") {
      throw state(`Teammate "${input.memberName}" cannot be paused from status ${member.status}.`)
    }

    if (member.status === "busy") {
      const ok = await interrupt(input.teamName, input.memberName, true)
      if (!ok) {
        throw state(`Teammate "${input.memberName}" did not stop after pause was requested.`)
      }
    }
    await transitionMemberStatus(input.teamName, input.memberName, "paused")
    if (input.reason) {
      const { TeamMessaging } = await import("./messaging")
      void TeamMessaging.send({
        teamName: input.teamName,
        from: "system",
        to: input.memberName,
        text: input.reason,
        type: "system",
      }).catch(() => {})
    }
  }

  export async function resume(input: { teamName: string; memberName: string; redirect?: string }): Promise<void> {
    const { TeamMessaging } = await import("./messaging")

    const team = await get(input.teamName)
    if (!team) throw new Error(`Team "${input.teamName}" not found`)

    const member = team.members.find((m) => m.name === input.memberName)
    if (!member) throw new Error(`Teammate "${input.memberName}" not found`)
    if (member.status !== "paused") {
      throw state(`Teammate "${input.memberName}" is ${member.status} — only paused teammates can be resumed.`)
    }

    await transitionMemberStatus(input.teamName, input.memberName, "busy")
    await TeamMessaging.recoverInbox(input.teamName, input.memberName, member.sessionID)
    await TeamMessaging.send({
      teamName: input.teamName,
      from: "lead",
      to: input.memberName,
      text: input.redirect ?? "Resume work, review queued team messages, and continue from your latest checkpoint.",
    })
  }

  export async function pauseAll(teamName: string, reason?: string) {
    const team = await get(teamName)
    if (!team) return
    for (const member of team.members) {
      if (member.status === "shutdown" || member.status === "shutdown_requested") continue
      await pause({ teamName, memberName: member.name, reason })
    }
  }

  export async function forceShutdownAll(teamName: string, reason?: string) {
    const team = await get(teamName)
    if (!team) return { shutdown: [] as string[], pending: [] as string[] }
    const result = { shutdown: [] as string[], pending: [] as string[] }
    for (const member of team.members) {
      if (member.status === "shutdown") {
        result.shutdown.push(member.name)
        continue
      }
      await transitionMemberStatus(teamName, member.name, "shutdown_requested", { force: true })
      if (member.status === "busy") {
        const ok = await interrupt(teamName, member.name, true)
        if (!ok) {
          result.pending.push(member.name)
          continue
        }
      }
      if (!(await stopped(member.sessionID))) {
        result.pending.push(member.name)
        continue
      }
      await transitionMemberStatus(teamName, member.name, "shutdown", { force: true })
      result.shutdown.push(member.name)
    }
    if (result.pending.length > 0) {
      await noticeLead(
        teamName,
        `Forced shutdown requested${reason ? `: ${reason}` : ""}. ${result.pending.join(", ")} are still running, so cleanup must wait for them to stop.`,
      )
    }
    return result
  }

  export function monitorCosts(_options?: { delay?: number }) {
    return () => {}
  }

  export async function checkBudget(_teamName: string) {
    return
  }

  export function checkpoints() {
    return Bus.subscribe(MessageV2.Event.PartUpdated, async (event) => {
      const part = event.properties.part
      if (part.type !== "tool") return
      if (part.state.status !== "completed") return
      if (checkpoint.has(part.id)) return
      checkpoint.add(part.id)

      const info = await findBySession(part.sessionID)
      if (!info || info.role !== "member" || !info.memberName) return
      const member = info.team.members.find((item) => item.name === info.memberName)
      if (!member) return
      const mode = member.checkpoint ?? "none"
      if (!checkpointMatch(mode, part.tool)) return
      if (member.status !== "busy") return

      await pause({ teamName: info.team.name, memberName: info.memberName })
      const { TeamMessaging } = await import("./messaging")
      await TeamMessaging.send({
        teamName: info.team.name,
        from: "system",
        to: "lead",
        text: `Checkpoint reached: "${info.memberName}" paused after tool "${part.tool}". Review their work and use resume to continue or redirect them.`,
      }).catch(() => {})
    })
  }

  /**
   * Cancel a single teammate's prompt loop by calling SessionPrompt.cancel.
   * This mirrors how the Task tool propagates abort to subagents (task.ts:121-125).
   * Returns true if the member was found and cancelled.
   */
  export async function cancelMember(teamName: string, memberName: string): Promise<boolean> {
    const team = await get(teamName)
    if (!team) return false

    const member = team.members.find((m) => m.name === memberName)
    if (!member) return false
    // Allow cancel for busy members and shutdown_requested members
    // (shutdown sets shutdown_requested before calling cancelMember,
    // so the member is no longer "busy" by the time we get here)
    if (member.status !== "busy" && member.status !== "shutdown_requested") return false
    return interrupt(teamName, memberName, false)
  }

  /**
   * Cancel all active teammates' prompt loops.
   * Returns the count of members that were cancelled.
   */
  export async function cancelAllMembers(teamName: string): Promise<number> {
    const { SessionPrompt } = await import("./runtime")
    const { SessionID } = await import("../session/schema")

    const team = await get(teamName)
    if (!team) return 0

    let count = 0
    for (const member of team.members) {
      if (member.status !== "busy") continue
      if (TERMINAL_EXECUTION_STATES.has(member.execution_status ?? "idle")) continue
      log.info("cancelling member", { teamName, memberName: member.name, sessionID: member.sessionID })
      await transitionExecutionStatus(teamName, member.name, "cancel_requested")
      await SessionPrompt.cancel(SessionID.make(member.sessionID))
      await transitionExecutionStatus(teamName, member.name, "cancelling")
      count++
    }
    return count
  }

  /**
   * Mark teammates that were busy when the server died as cancelled
   * and inject a notification into the lead session.
   * Called once during InstanceBootstrap.
   */
  export async function recover(): Promise<{ interrupted: number }> {
    const { Session } = await import("./runtime")
    const { SessionID } = await import("../session/schema")
    const { Inbox } = await import("./inbox")

    const known = new Set(
      (await list()).flatMap((team) => [team.leadSessionID, ...team.members.map((member) => member.sessionID)]),
    )
    for (const session of await Session.list({ limit: 10_000 })) {
      if (known.has(session.id)) continue
      if (!session.parentID) continue
      if (!session.title.includes(" teammate")) continue
      const meta =
        (await readSessionMeta(session.id)) ??
        sessionMeta(
          (await Session.messages({ sessionID: SessionID.make(session.id), limit: 20 }).catch(() => []))
            .find((msg) => msg.info.role === "user")
            ?.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n") ?? "",
        )
      if (!meta) continue
      let team = await get(meta.teamName)
      if (!team) {
        const tasks = await Storage.read<TeamTask[]>(tasksKey(meta.teamName))
          .then(() => true)
          .catch(() => false)
        const memberInbox = await Inbox.all(meta.teamName, meta.name).then((items) => items.length > 0)
        const leadInbox = await Inbox.all(meta.teamName, "lead").then((items) => items.length > 0)
        if (!tasks && !memberInbox && !leadInbox) continue
        team = await create({
          name: meta.teamName,
          leadSessionID: session.parentID,
        }).catch((err: unknown) => {
          log.warn("failed to recreate orphaned team config", {
            teamName: meta.teamName,
            sessionID: session.id,
            error: err instanceof Error ? err.message : String(err),
          })
          return undefined
        })
      }
      if (!team) continue
      if (team.leadSessionID !== session.parentID) {
        log.warn("skipping orphaned teammate with mismatched lead", {
          teamName: meta.teamName,
          sessionID: session.id,
          leadSessionID: session.parentID,
          expectedLeadSessionID: team.leadSessionID,
        })
        continue
      }
      if (team.members.some((member) => member.sessionID === session.id || member.name === meta.name)) {
        known.add(session.id)
        continue
      }
      const added = await addMember(meta.teamName, {
        name: meta.name,
        sessionID: session.id,
        agent: meta.agent,
        status: "ready",
        execution_status: "idle",
        updated: Date.now(),
        prompt: meta.prompt,
        model: meta.model,
        planApproval: session.permission?.some((rule: Rule) => rule.pattern === "*:plan-approval") ? "pending" : "none",
        checkpoint: "none",
        activeDelegations: 0,
      }).catch((err: unknown) => {
        log.warn("failed to reconcile orphaned teammate", {
          teamName: meta.teamName,
          memberName: meta.name,
          sessionID: session.id,
          error: err instanceof Error ? err.message : String(err),
        })
        return false
      })
      if (added !== false) known.add(session.id)
    }

    const teams = await list()
    let count = 0

    for (const team of teams) {
      if (team.members.some((member) => (member.activeDelegations ?? 0) > 0)) {
        await Storage.update<TeamInfo>(configKey(team.name), (draft) => {
          draft.members = draft.members.map((member) => ({ ...member, activeDelegations: 0 }))
        }).catch(() => {})
      }

      const live = team.members.filter((m) => m.status !== "shutdown")
      try {
        const { TeamMessaging } = await import("./messaging")
        for (const member of live) {
          await Inbox.validate(team.name, member.name)
          await TeamMessaging.recoverInbox(team.name, member.name, member.sessionID)
        }
        await Inbox.validate(team.name, "lead")
        await TeamMessaging.recoverInbox(team.name, "lead", team.leadSessionID)
      } catch (err: unknown) {
        log.warn("inbox recovery failed", {
          teamName: team.name,
          error: err instanceof Error ? err.message : String(err),
        })
      }

      const active = team.members.filter((m) => m.status === "busy")
      if (active.length === 0) continue

      log.info("marking interrupted teammates", { teamName: team.name, count: active.length })

      const names: string[] = []
      for (const member of active) {
        await transitionExecutionStatus(team.name, member.name, "cancelled", { force: true })
        await transitionExecutionStatus(team.name, member.name, "idle", { force: true })
        await transitionMemberStatus(team.name, member.name, "ready", { force: true })
        names.push(member.name)
        count++
      }
      try {
        const { Session } = await import("./runtime")
        const { SessionID, MessageID, PartID } = await import("../session/schema")
        const { ProviderID, ModelID } = await import("../provider/schema")
        const leadSessionID = SessionID.make(team.leadSessionID)
        const msgs = await Session.messages({ sessionID: leadSessionID })
        const lastUser = msgs.findLast((m) => m.info.role === "user")
        if (lastUser) {
          const info = lastUser.info as { agent: string; model: { providerID: string; modelID: string } }
          const msgId = MessageID.ascending()
          await Session.updateMessage({
            id: msgId,
            sessionID: leadSessionID,
            role: "user",
            agent: info.agent,
            model: {
              providerID: ProviderID.make(info.model.providerID),
              modelID: ModelID.make(info.model.modelID),
            },
            time: { created: Date.now() },
          })
          await Session.updatePart({
            id: PartID.ascending(),
            messageID: msgId,
            sessionID: leadSessionID,
            type: "text",
            text: `[System]: Server was restarted. The following teammates in team "${team.name}" were interrupted and need to be resumed: ${names.join(", ")}. Use team_message or team_broadcast to tell them to continue their work.`,
            synthetic: true,
          })
        }
      } catch (err: unknown) {
        log.warn("failed to notify lead of interrupted teammates", {
          teamName: team.name,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    if (count > 0) log.info("team recovery complete", { interrupted: count })
    return { interrupted: count }
  }
}

export namespace TeamTasks {
  /**
   * Read all tasks for a team.
   */
  export async function list(teamName: string): Promise<TeamTask[]> {
    try {
      return await Storage.read<TeamTask[]>(tasksKey(teamName))
    } catch {
      return []
    }
  }

  /**
   * Write the full task list for a team (replaces).
   */
  export async function update(teamName: string, tasks: TeamTask[]): Promise<void> {
    const resolved = resolveDependencies(tasks)
    await Storage.write(tasksKey(teamName), resolved)
    await Bus.publish(TeamEvent.TaskUpdated, { teamName, tasks: resolved })
  }

  /**
   * Add tasks to the team's task list.
   */
  export async function add(teamName: string, newTasks: TeamTask[]): Promise<void> {
    const existing = await list(teamName)
    const resolved = resolveDependencies([...existing, ...newTasks])
    await Storage.write(tasksKey(teamName), resolved)
    await Bus.publish(TeamEvent.TaskUpdated, { teamName, tasks: resolved })
  }

  /**
   * Atomically claim a task. Returns true if claimed, false if already taken.
   */
  export async function claim(teamName: string, taskId: string, memberName: string): Promise<boolean> {
    let claimed = false
    let content = ""
    const mark = Date.now()
    try {
      await Storage.update<TeamTask[]>(tasksKey(teamName), (tasks) => {
        const task = tasks.find((t) => t.id === taskId)
        if (!task) return
        if (task.status !== "pending") return
        if (task.assignee) return

        if (task.depends_on?.length) {
          const unresolved = task.depends_on.some((depId) => {
            const dep = tasks.find((t) => t.id === depId)
            return !dep || (dep.status !== "completed" && dep.status !== "cancelled")
          })
          if (unresolved) return
        }

        task.status = "in_progress"
        task.assignee = memberName
        content = task.content
        claimed = true
      })
    } catch {
      return false
    }

    if (claimed) {
      await Team.setMemberAssignedAt(teamName, memberName, mark)
      await Bus.publish(TeamEvent.TaskClaimed, { teamName, taskId, memberName })
      await TeamPolicy.taskClaimed({ teamName, taskId, taskContent: content, claimedBy: memberName })
    }
    return claimed
  }

  /**
   * Mark a task as completed.
   */
  export async function complete(teamName: string, taskId: string): Promise<void> {
    let tasks: TeamTask[] = []
    try {
      tasks = await Storage.update<TeamTask[]>(tasksKey(teamName), (draft) => {
        const task = draft.find((t) => t.id === taskId)
        if (task) task.status = "completed"
        const resolved = resolveDependencies(draft)
        // Mutate in-place — Storage.update serializes the original reference,
        // so reassignment (draft = resolved) wouldn't propagate
        draft.length = 0
        draft.push(...resolved)
      })
    } catch {
      return
    }
    await Bus.publish(TeamEvent.TaskUpdated, { teamName, tasks })
  }

  function resolveDependencies(tasks: TeamTask[]): TeamTask[] {
    const validIds = new Set(tasks.map((t) => t.id))

    return tasks.map((task) => {
      if (task.depends_on) {
        task = { ...task, depends_on: task.depends_on.filter((id) => validIds.has(id) && id !== task.id) }
      }
      if (!task.depends_on?.length) return task

      const unresolved = task.depends_on.some((depId) => {
        const dep = tasks.find((t) => t.id === depId)
        return !dep || (dep.status !== "completed" && dep.status !== "cancelled")
      })

      if (unresolved && task.status === "pending") return { ...task, status: "blocked" }
      if (!unresolved && task.status === "blocked") return { ...task, status: "pending" }
      return task
    })
  }
}
