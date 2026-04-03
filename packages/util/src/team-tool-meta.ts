function text(value: unknown) {
  if (typeof value !== "string" || !value) return
  return value
}

function flag(value: unknown) {
  return value === true
}

export type TeamToolMeta =
  | {
      kind: "spawn"
      name?: string
      subtitle?: string
      sessionID?: string
    }
  | {
      kind: "delegate"
      subtitle?: string
      sessionID?: string
    }
  | {
      kind: "create"
      name?: string
    }

export function teamSession(tool: string, metadata: Record<string, unknown> = {}) {
  const id = text(metadata.sessionId)
  if (!id) return
  if (tool === "team_spawn") return id
  if (tool === "team_delegate") return id
  if (tool === "team_request_spawn" && flag(metadata.approved)) return id
}

export function defaultTeamSession(metadata: Record<string, unknown> = {}) {
  return teamSession("team_spawn", metadata)
}

export function teamToolMeta(
  tool: string,
  input: Record<string, unknown> = {},
  metadata: Record<string, unknown> = {},
): TeamToolMeta | undefined {
  if (tool === "team_spawn" || (tool === "team_request_spawn" && teamSession(tool, metadata))) {
    return {
      kind: "spawn",
      name: text(input.name) ?? text(metadata.memberName) ?? text(input.agent),
      subtitle: text(input.prompt),
      sessionID: teamSession(tool, metadata),
    }
  }

  if (tool === "team_delegate") {
    return {
      kind: "delegate",
      subtitle: text(input.description),
      sessionID: teamSession(tool, metadata),
    }
  }

  if (tool === "team_create") {
    return {
      kind: "create",
      name: text(input.name) ?? text(metadata.teamName),
    }
  }
}
