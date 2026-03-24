import { createMemo } from "solid-js"
import { useDialog } from "../../ui/dialog"
import { DialogPrompt } from "../../ui/dialog-prompt"
import { useSync } from "../../context/sync"
import { useSDK } from "../../context/sdk"
import { useToast } from "../../ui/toast"
import { useTheme } from "../../context/theme"

export function DialogTeamSteer(props: { sessionID: string }) {
  const dialog = useDialog()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()
  const team = createMemo(() => sync.data.team[props.sessionID])

  return (
    <DialogPrompt
      title={team()?.memberName ? `Steer @${team()!.memberName}` : "Steer teammate"}
      placeholder="Give the teammate their next instruction"
      description={() => (
        <text fg={theme.textMuted} wrapMode="word">
          Send a lead instruction to the opened delegated teammate. Idle or errored teammates will be restarted; active
          teammates will receive the instruction inline.
        </text>
      )}
      onConfirm={async (value) => {
        const info = team()
        if (!info || info.role !== "member" || !info.memberName) {
          toast.show({ message: "This session is not a delegated teammate", variant: "error" })
          return
        }

        const text = value.trim()
        if (!text) return

        try {
          const res = await sdk.fetch(`${sdk.url}/team/${info.teamName}/steer`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-opencode-session": info.leadSessionID,
            },
            body: JSON.stringify({ member: info.memberName, text }),
          })

          if (!res.ok) {
            const body = await res.json().catch(() => undefined)
            throw new Error(body?.error ?? "Failed to steer teammate")
          }

          const body = await res.json().catch(() => undefined)
          toast.show({
            message:
              body?.action === "restart"
                ? `Restarted @${info.memberName} with new instructions`
                : `Sent new instructions to @${info.memberName}`,
            variant: "success",
          })
          dialog.clear()
        } catch (err) {
          toast.show({
            message: err instanceof Error ? err.message : `Failed to steer @${info.memberName}`,
            variant: "error",
          })
        }
      }}
    />
  )
}
