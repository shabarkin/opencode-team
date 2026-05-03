import type { Permission } from "@/permission"

export function childPermission(input: {
  tools: readonly string[]
  pad?: boolean
  todo?: boolean
  task?: boolean
  primary?: string[]
  parent?: Permission.Rule[]
}) {
  return [
    ...(input.todo
      ? []
      : [
          {
            permission: "todowrite" as const,
            pattern: "*" as const,
            action: "deny" as const,
          },
          {
            permission: "todoread" as const,
            pattern: "*" as const,
            action: "deny" as const,
          },
        ]),
    ...input.tools.map((tool) => ({
      permission: tool,
      pattern: "*",
      action: "deny" as const,
    })),
    ...(input.pad
      ? [
          {
            permission: "team_notepad",
            pattern: "read",
            action: "allow" as const,
          },
          {
            permission: "team_notepad",
            pattern: "list",
            action: "allow" as const,
          },
          {
            permission: "team_notepad",
            pattern: "write",
            action: "deny" as const,
          },
          {
            permission: "team_notepad",
            pattern: "delete",
            action: "deny" as const,
          },
        ]
      : []),
    ...(input.task
      ? []
      : [
          {
            permission: "task" as const,
            pattern: "*" as const,
            action: "deny" as const,
          },
        ]),
    ...(input.primary?.map((tool) => ({
      pattern: "*",
      action: "allow" as const,
      permission: tool,
    })) ?? []),
    ...(input.parent ?? []).filter((rule) => rule.permission === "external_directory" || rule.action === "deny"),
  ]
}
