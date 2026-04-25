import type { ToolPart } from "@opencode-ai/sdk/v2"
import { teamSession, teamToolMeta } from "@opencode-ai/shared/util/team-tool-meta"

function text(value: unknown) {
  if (typeof value !== "string" || !value) return
  return value
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
  if (part.tool === "task") return id
  return teamSession(part.tool, meta(part))
}

export function teamTool(part: ToolPart) {
  const next = teamToolMeta(part.tool, input(part), meta(part))
  if (!next) return
  if (next.kind === "spawn") {
    return {
      icon: "│",
      pending: "Spawning teammate...",
      title: next.name ? `Teammate: ${next.name}` : "Teammate",
      subtitle: next.subtitle,
    }
  }
  if (next.kind === "delegate") {
    return {
      icon: "│",
      pending: "Delegating...",
      title: "Delegate",
      subtitle: next.subtitle,
    }
  }
  return {
    icon: "⑂",
    pending: "Creating team...",
    title: next.name ? `Created team: ${next.name}` : "Create team",
  }
}
