import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, For, Show, createSignal } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { teamStatusIcon } from "@/team/status-view"

const id = "internal:sidebar-team"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function statusColor(status: string, theme: any): string {
  switch (status) {
    case "busy":
      return theme.primary
    case "paused":
    case "shutdown_requested":
      return theme.warning
    case "ready":
      return theme.textMuted
    case "shutdown":
    case "error":
      return theme.error
    default:
      return theme.textMuted
  }
}

function View(props: { session_id: string }) {
  const { theme } = useTheme()
  const sync = useSync()
  const [open, setOpen] = createSignal(true)
  const teamData = createMemo(() => sync.data.team[props.session_id])

  return (
    <Show when={teamData()}>
      {(data) => (
        <box>
          <box flexDirection="row" gap={1} onMouseDown={() => setOpen((x) => !x)}>
            <text fg={theme.text}>{open() ? "▼" : "▶"}</text>
            <text fg={theme.text}>
              <b>Team</b>{" "}
              <span style={{ fg: theme.textMuted }}>
                {data().teamName} ({data().role}){data().delegate ? " [delegate]" : ""}
              </span>
            </text>
          </box>
          <Show when={open()}>
            <For each={data().members}>
              {(m) => (
                <box flexDirection="row" gap={1}>
                  <text flexShrink={0} style={{ fg: statusColor(m.status, theme) }}>
                    {teamStatusIcon(m.status)}
                  </text>
                  <text fg={theme.text} wrapMode="word">
                    {m.name}{" "}
                    <span style={{ fg: theme.textMuted }}>
                      @{m.agent}
                      {m.execution_status !== "idle" ? ` (${m.execution_status})` : ""}
                    </span>
                  </text>
                </box>
              )}
            </For>
            <Show when={data().tasks.length > 0}>
              <text fg={theme.textMuted}>
                Tasks: {data().tasks.filter((t) => t.status === "completed").length}/{data().tasks.length} done
              </text>
            </Show>
          </Show>
        </box>
      )}
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 200,
    slots: {
      sidebar_content(_ctx, props) {
        return <View session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
