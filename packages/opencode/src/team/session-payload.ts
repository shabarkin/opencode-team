export type TeamMemberState = {
  name: string
  sessionID?: string
  agent: string
  status: "ready" | "busy" | "paused" | "shutdown_requested" | "shutdown" | "error"
  execution_status:
    | "idle"
    | "starting"
    | "running"
    | "cancel_requested"
    | "cancelling"
    | "cancelled"
    | "completing"
    | "completed"
    | "failed"
    | "timed_out"
  model?: string
  planApproval?: "none" | "pending" | "approved" | "rejected"
  checkpoint?: "none" | "after_each_write" | "after_each_tool"
}

export type TeamSpawnState = {
  id: string
  requested_by: string
  agent: string
  rationale?: string
  name?: string
  prompt?: string
  created: number
}

export type TeamTaskState = {
  id: string
  content: string
  status: string
  priority: string
  assignee?: string
  depends_on?: string[]
}

export type TeamSessionState = {
  teamName: string
  leadSessionID?: string
  role: "lead" | "member"
  memberName?: string
  delegate?: boolean
  members: TeamMemberState[]
  pendingSpawnRequests: TeamSpawnState[]
  tasks: TeamTaskState[]
}

export function mapTeamSession(data: {
  team: {
    name: string
    delegate?: boolean
    members?: TeamMemberState[]
    pending_spawn_requests?: TeamSpawnState[]
  }
  leadSessionID?: string
  role: "lead" | "member"
  memberName?: string
  tasks?: TeamTaskState[]
}): TeamSessionState {
  return {
    teamName: data.team.name,
    leadSessionID: data.leadSessionID,
    role: data.role,
    memberName: data.memberName,
    delegate: data.team.delegate,
    members: data.team.members ?? [],
    pendingSpawnRequests: data.team.pending_spawn_requests ?? [],
    tasks: data.tasks ?? [],
  }
}

export async function loadTeamSession(input: {
  url: string
  fetch: typeof fetch
  sessionID: string
}): Promise<TeamSessionState | null | undefined> {
  const res = await input
    .fetch(`${input.url}/team/by-session/${input.sessionID}`, {
      headers: {
        "x-opencode-session": input.sessionID,
      },
    })
    .catch(() => undefined)
  if (!res?.ok) return undefined
  const data = await res.json().catch(() => undefined)
  if (data === undefined) return undefined
  if (data === null) return null
  return mapTeamSession(data)
}
