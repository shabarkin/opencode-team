import { useDialog } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { createMemo, onMount, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useSync } from "../context/sync"
import { useRouteData } from "../context/route"
import { useRoute } from "../context/route"
import { teamStatusIcon } from "../team/status-view"

type Value = { type: "member"; sessionID?: string } | { type: "task"; id: string } | { type: "request"; id: string }

function statusColor(status: string, theme: any): string {
  switch (status) {
    case "busy":
      return theme.primary
    case "paused":
      return theme.warning
    case "ready":
      return theme.textMuted
    case "shutdown_requested":
      return theme.warning
    case "shutdown":
      return theme.error
    case "error":
      return theme.error
    case "completed":
      return theme.success
    case "in_progress":
      return theme.primary
    case "blocked":
      return theme.error
    case "pending":
      return theme.textMuted
    default:
      return theme.textMuted
  }
}

export function DialogTeam() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const sync = useSync()
  const route = useRouteData("session")
  const nav = useRoute()

  const teamInfo = createMemo(() => sync.data.team[route.sessionID])

  // Refresh team data on open
  onMount(() => {
    dialog.setSize("large")
    void sync.team.sync(route.sessionID)
  })

  const options = createMemo((): DialogSelectOption<Value>[] => {
    const info = teamInfo()
    if (!info) return []

    const leadOption: DialogSelectOption<Value>[] =
      info.role === "member" && info.leadSessionID
        ? [
            {
              title: "Lead",
              value: { type: "member", sessionID: info.leadSessionID },
              category: "Navigation",
              footer: "Return to team lead",
              gutter: () => <text fg={theme.primary}>{"<"}</text>,
            },
          ]
        : []

    const memberOptions: DialogSelectOption<Value>[] = info.members.map((m) => ({
      title: `${m.name} (@${m.agent})`,
      value: { type: "member", sessionID: m.sessionID },
      category: "Teammates",
      footer: `Status: ${m.status}`,
      gutter: () => <text fg={statusColor(m.status, theme)}>{teamStatusIcon(m.status)}</text>,
      disabled: !m.sessionID,
    }))

    const taskOptions: DialogSelectOption<Value>[] = (info.tasks ?? []).map((t) => ({
      title: t.content,
      value: { type: "task", id: t.id },
      category: "Shared Tasks",
      footer: [
        t.status,
        t.assignee ? `@${t.assignee}` : null,
        t.depends_on?.length ? `depends: ${t.depends_on.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join(" | "),
      gutter: () => <text fg={statusColor(t.status, theme)}>{teamStatusIcon(t.status)}</text>,
      disabled: t.status === "completed" || t.status === "cancelled",
    }))

    const spawnOptions: DialogSelectOption<Value>[] = (info.pendingSpawnRequests ?? []).map((request) => ({
      title: `${request.requested_by} → ${request.agent}${request.name ? ` as ${request.name}` : ""}`,
      value: { type: "request", id: request.id },
      category: "Pending Spawn Requests",
      footer: request.rationale,
      gutter: () => <text fg={theme.warning}>?</text>,
    }))

    return [...leadOption, ...memberOptions, ...taskOptions, ...spawnOptions]
  })

  const handleSelect = (option: DialogSelectOption<Value>) => {
    if (option.value.type === "member" && option.value.sessionID) {
      dialog.clear()
      nav.navigate({ type: "session", sessionID: option.value.sessionID })
    }
  }

  return (
    <Show
      when={teamInfo()}
      fallback={
        <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme.text} attributes={1}>
              Agent Team
            </text>
            <text fg={theme.textMuted}>esc</text>
          </box>
          <text fg={theme.textMuted}>No active team for this session.</text>
          <text fg={theme.textMuted}>The lead agent can create a team using the team_create tool.</text>
        </box>
      }
    >
      <DialogSelect
        title={`Team: ${teamInfo()!.teamName} (${teamInfo()!.role})`}
        options={options()}
        onSelect={handleSelect}
      />
    </Show>
  )
}
