type ToolText = (key: string) => string

export type TeamLabel = {
  icon: "task" | "fork"
  title: string
  subtitle?: string
}

function text(value: unknown) {
  if (typeof value !== "string" || !value) return
  return value
}

export function teamLabel(
  tool: string,
  input: Record<string, unknown> = {},
  metadata: Record<string, unknown> = {},
  t: ToolText,
): TeamLabel | undefined {
  if (tool === "team_spawn") {
    const name = text(input.name) ?? text(metadata.memberName)
    return {
      icon: "task",
      title: name ? `${t("ui.tool.team.spawn")}: ${name}` : t("ui.tool.team.spawn"),
      subtitle: text(input.prompt),
    }
  }

  if (tool === "team_delegate") {
    return {
      icon: "task",
      title: t("ui.tool.team.delegate"),
      subtitle: text(input.description),
    }
  }

  if (tool === "team_create") {
    const name = text(input.name) ?? text(metadata.teamName)
    return {
      icon: "fork",
      title: name ? `Created team: ${name}` : t("ui.tool.team.create"),
    }
  }
}

export function teamSession(metadata: Record<string, unknown> = {}) {
  return text(metadata.sessionId)
}
