import type { ToolPart } from "@opencode-ai/sdk/v2"

function text(value: unknown) {
  if (typeof value !== "string" || !value) return
  return value
}

function flag(value: unknown) {
  return value === true
}

function meta(part: ToolPart) {
  if (!("metadata" in part.state) || !part.state.metadata) return {}
  return part.state.metadata as Record<string, unknown>
}

function input(part: ToolPart) {
  return part.state.input as Record<string, unknown>
}

export function childSession(part: ToolPart) {
  const id = text(meta(part).sessionId)
  if (!id) return
  if (part.tool === "task") return id
  if (part.tool === "team_spawn") return id
  if (part.tool === "team_delegate") return id
  if (part.tool === "team_request_spawn" && flag(meta(part).approved)) return id
}

export function teamTool(part: ToolPart) {
  const data = input(part)
  const info = meta(part)

  if (part.tool === "team_spawn" || (part.tool === "team_request_spawn" && flag(info.approved) && childSession(part))) {
    const name = text(data.name) ?? text(info.memberName) ?? text(data.agent)
    return {
      icon: "│",
      pending: "Spawning teammate...",
      title: name ? `Teammate: ${name}` : "Teammate",
      subtitle: text(data.prompt),
    }
  }

  if (part.tool === "team_delegate") {
    return {
      icon: "│",
      pending: "Delegating...",
      title: "Delegate",
      subtitle: text(data.description),
    }
  }

  if (part.tool === "team_create") {
    const name = text(data.name) ?? text(info.teamName)
    return {
      icon: "⑂",
      pending: "Creating team...",
      title: name ? `Created team: ${name}` : "Create team",
    }
  }
}
