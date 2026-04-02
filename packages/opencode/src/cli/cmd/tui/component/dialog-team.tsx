import { useDialog } from "@tui/ui/dialog"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { createMemo, onMount, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useSync } from "../context/sync"
import { useRouteData } from "../context/route"
import { useRoute } from "../context/route"
import { useToast } from "../ui/toast"
import { useSDK } from "../context/sdk"

type Value = { type: "member"; sessionID?: string } | { type: "task"; id: string } | { type: "request"; id: string }

function statusIcon(status: string): string {
  switch (status) {
    case "busy":
      return "*"
    case "paused":
      return "||"
    case "ready":
      return "o"
    case "shutdown_requested":
      return "!"
    case "shutdown":
      return "x"
    case "completed":
      return "+"
    case "in_progress":
      return ">"
    case "blocked":
      return "#"
    case "cancelled":
      return "-"
    case "pending":
      return " "
    default:
      return "?"
  }
}

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
  const toast = useToast()
  const sdk = useSDK()

  const teamInfo = createMemo(() => sync.data.team[route.sessionID])

  // Refresh team data on open
  onMount(() => {
    dialog.setSize("large")
    sdk
      .fetch(`${sdk.url}/team/by-session/${route.sessionID}`, {
        headers: {
          "x-opencode-session": route.sessionID,
        },
      })
      .then((r: Response) => r.json())
      .then((data: any) => {
        if (!data) return
        sync.set("team", route.sessionID, {
          teamName: data.team.name,
          leadSessionID: data.leadSessionID,
          role: data.role,
          memberName: data.memberName,
          delegate: data.team.delegate,
          members: data.team.members ?? [],
          pendingSpawnRequests: data.team.pending_spawn_requests ?? [],
          tasks: data.tasks ?? [],
        })
      })
      .catch(() => {})
  })

  const options = createMemo((): DialogSelectOption<Value>[] => {
    const info = teamInfo()
    if (!info) return []

    const memberOptions: DialogSelectOption<Value>[] = info.members.map((m) => ({
      title: `${m.name} (@${m.agent})`,
      value: { type: "member", sessionID: m.sessionID },
      category: "Teammates",
      footer: `Status: ${m.status}`,
      gutter: <text fg={statusColor(m.status, theme)}>{statusIcon(m.status)}</text>,
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
      gutter: <text fg={statusColor(t.status, theme)}>{statusIcon(t.status)}</text>,
      disabled: t.status === "completed" || t.status === "cancelled",
    }))

    const spawnOptions: DialogSelectOption<Value>[] = (info.pendingSpawnRequests ?? []).map((request) => ({
      title: `${request.requested_by} → ${request.agent}${request.name ? ` as ${request.name}` : ""}`,
      value: { type: "request", id: request.id },
      category: "Pending Spawn Requests",
      footer: request.rationale,
      gutter: <text fg={theme.warning}>?</text>,
    }))

    return [...memberOptions, ...taskOptions, ...spawnOptions]
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
        keybind={[
          {
            keybind: { name: "m", ctrl: false, meta: false, shift: false, leader: false },
            title: "message",
            onTrigger: (option) => {
              if (option.value.type === "member") {
                toast.show({ message: "Use team_message tool from the prompt to message teammates", variant: "info" })
              }
            },
          },
          {
            keybind: { name: "l", ctrl: false, meta: false, shift: false, leader: false },
            title: "go to lead",
            onTrigger: () => {
              const info = teamInfo()
              if (!info?.leadSessionID) return
              dialog.clear()
              nav.navigate({ type: "session", sessionID: info.leadSessionID })
            },
          },
        ]}
      />
    </Show>
  )
}
