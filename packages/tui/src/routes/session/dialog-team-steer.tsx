import { createMemo } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { useDialog } from "../../ui/dialog"
import { DialogPrompt } from "../../ui/dialog-prompt"
import { useSync } from "../../context/sync"
import { useSDK } from "../../context/sdk"
import { useToast } from "../../ui/toast"

type Action = "message" | "pause" | "resume" | "cancel" | "steer-all"

export function DialogTeamSteer(props: { sessionID: string }) {
  const dialog = useDialog()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const team = createMemo(() => sync.data.team[props.sessionID])

  const options = createMemo((): DialogSelectOption<{ action: Action; member?: string }>[] => {
    const info = team()
    if (!info) return []
    if (info.role !== "lead") return []

    const members = info.members

    const actions = members.flatMap((member) => [
      {
        title: `Message @${member.name}`,
        value: { action: "message" as const, member: member.name },
        category: `@${member.name}`,
        footer: `Status: ${member.status}`,
      },
      {
        title: `Pause @${member.name}`,
        value: { action: "pause" as const, member: member.name },
        category: `@${member.name}`,
        footer: `Status: ${member.status}`,
        disabled: member.status === "paused" || member.status === "shutdown" || member.status === "shutdown_requested",
      },
      {
        title: `Resume @${member.name}`,
        value: { action: "resume" as const, member: member.name },
        category: `@${member.name}`,
        footer: `Status: ${member.status}`,
        disabled: member.status !== "paused",
      },
      {
        title: `Cancel @${member.name}`,
        value: { action: "cancel" as const, member: member.name },
        category: `@${member.name}`,
        footer: `Status: ${member.status}`,
        disabled: member.status !== "busy",
      },
    ])

    if (info.role !== "lead") return actions
    return [
      ...actions,
      {
        title: "Steer all active teammates",
        value: { action: "steer-all" as const },
        category: "Team",
        footer: "Broadcast updated instructions to the full team",
      },
    ]
  })

  async function request(path: string, body: Record<string, unknown>, success: string) {
    const info = team()
    if (!info || info.role !== "lead") return

    const res = await sdk.fetch(`${sdk.url}/team/${info.teamName}/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-session": props.sessionID,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const next = await res.json().catch(() => undefined)
      throw new Error(next?.error ?? `Failed to ${path}`)
    }

    toast.show({ message: success, variant: "success" })
    dialog.clear()
  }

  async function prompt(title: string, placeholder: string) {
    const value = await DialogPrompt.show(dialog, title, { placeholder })
    if (value === null) return
    return value.trim()
  }

  return (
    <DialogSelect
      title="Steer team"
      placeholder="Search teammate or action"
      options={options()}
      onSelect={async (option) => {
        const info = team()
        if (!info) {
          toast.show({ message: "No team data for this session", variant: "error" })
          return
        }

        try {
          if (option.value.action === "pause" && option.value.member) {
            await request("pause", { member: option.value.member }, `Paused @${option.value.member}`)
            return
          }

          if (option.value.action === "cancel" && option.value.member) {
            await request("cancel", { member: option.value.member }, `Cancelled @${option.value.member}`)
            return
          }

          if (option.value.action === "resume" && option.value.member) {
            const value = await prompt(`Resume @${option.value.member}`, "Optional redirect before resuming")
            await request(
              "resume",
              { member: option.value.member, redirect: value || undefined },
              value ? `Resumed @${option.value.member} with redirect` : `Resumed @${option.value.member}`,
            )
            return
          }

          if (option.value.action === "steer-all") {
            const text = await prompt("Steer all", "Give all active teammates their next instruction")
            if (!text) return
            await request("steer-all", { text }, "Broadcast new team instructions")
            return
          }

          if (option.value.member) {
            const text = await prompt(`Message @${option.value.member}`, "Give the teammate their next instruction")
            if (!text) return
            await request(
              "steer",
              { member: option.value.member, text },
              `Sent new instructions to @${option.value.member}`,
            )
          }
        } catch (err) {
          toast.show({
            message: err instanceof Error ? err.message : "Failed to steer team",
            variant: "error",
          })
        }
      }}
    />
  )
}
