import { defaultTeamSession, teamToolMeta } from "@opencode-ai/core/util/team-tool-meta"

type Vars = Record<string, string | number | boolean>

type TextFn = (key: string, params?: Vars) => string

export type TeamLabel = {
  icon: "task" | "fork"
  title: string
  subtitle?: string
}

function spawn(name: string | undefined, subtitle: string | undefined, t: TextFn) {
  return {
    icon: "task" as const,
    title: name ? `${t("ui.tool.team.spawn")}: ${name}` : t("ui.tool.team.spawn"),
    subtitle,
  }
}

export function teamLabel(
  tool: string,
  input: Record<string, unknown> = {},
  metadata: Record<string, unknown> = {},
  t: TextFn,
): TeamLabel | undefined {
  const next = teamToolMeta(tool, input, metadata)
  if (!next) return
  if (next.kind === "spawn") {
    return spawn(next.name, next.subtitle, t)
  }
  if (next.kind === "delegate") {
    return {
      icon: "task",
      title: t("ui.tool.team.delegate"),
      subtitle: next.subtitle,
    }
  }
  return {
    icon: "fork",
    title: next.name ? t("ui.tool.team.create.created", { name: next.name }) : t("ui.tool.team.create"),
  }
}

export function teamSession(metadata: Record<string, unknown> = {}) {
  return defaultTeamSession(metadata)
}
