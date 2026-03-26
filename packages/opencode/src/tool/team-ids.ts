export const TEAM_TOOL_IDS = [
  "team_create",
  "team_spawn",
  "team_request_spawn",
  "team_message",
  "team_reply",
  "team_broadcast",
  "team_delegate",
  "team_inbox",
  "team_submit_result",
  "team_wait",
  "team_collect",
  "team_tasks",
  "team_claim",
  "team_approve_plan",
  "team_shutdown_all",
  "team_shutdown",
  "team_cleanup",
  "team_phase",
  "team_status",
  "team_notepad",
  "team_health",
  "team_restart",
] as const

/** Lead-only tools — denied for team members, only the lead can use these */
export const TEAM_LEAD_ONLY_IDS = [
  "team_create",
  "team_spawn",
  "team_shutdown",
  "team_cleanup",
  "team_approve_plan",
] as const

/**
 * Team tools that members should always have access to, regardless of agent permissions.
 * Derived from TEAM_TOOL_IDS minus TEAM_LEAD_ONLY_IDS.
 *
 * This ensures restrictive agents (those with "*": "deny") don't accidentally
 * block team communication tools when used as team members.
 */
export const TEAM_MEMBER_ALLOWED_IDS = TEAM_TOOL_IDS.filter(
  (id): id is Exclude<(typeof TEAM_TOOL_IDS)[number], (typeof TEAM_LEAD_ONLY_IDS)[number]> =>
    !(TEAM_LEAD_ONLY_IDS as readonly string[]).includes(id),
)
