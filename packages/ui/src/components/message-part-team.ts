type Vars = Record<string, string | number | boolean>

type TextFn = (key: string, params?: Vars) => string

export type TeamLabel = {
  icon: "task" | "fork"
  title: string
  subtitle?: string
}

function text(value: unknown) {
  if (typeof value !== "string" || !value) return
  return value
}

function flag(value: unknown) {
  return value === true
}

function spawn(input: Record<string, unknown>, metadata: Record<string, unknown>, t: TextFn) {
  const name = text(input.name) ?? text(metadata.memberName) ?? text(input.agent)
  return {
    icon: "task" as const,
    title: name ? `${t("ui.tool.team.spawn")}: ${name}` : t("ui.tool.team.spawn"),
    subtitle: text(input.prompt),
  }
}

export function teamLabel(
  tool: string,
  input: Record<string, unknown> = {},
  metadata: Record<string, unknown> = {},
  t: TextFn,
): TeamLabel | undefined {
  if (tool === "team_spawn") {
    return spawn(input, metadata, t)
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
      title: name ? t("ui.tool.team.create.created", { name }) : t("ui.tool.team.create"),
    }
  }

  if (tool === "team_request_spawn" && flag(metadata.approved) && teamSession(metadata)) {
    return spawn(input, metadata, t)
  }
}

export function teamSession(metadata: Record<string, unknown> = {}) {
  return text(metadata.sessionId)
}
