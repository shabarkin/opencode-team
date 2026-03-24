import { Log } from "../util/log"
import { Bus } from "../bus"
import { Session } from "../session"
import { Team, TeamEvent } from "./index"
import { TeamMessaging } from "./messaging"

const log = Log.create({ service: "team.files" })

/** Tracks which team member last edited a file and when */
interface FileEdit {
  memberName: string
  sessionID: string
  timestamp: number
}

/** In-memory map: filepath → last editor */
const edits = new Map<string, FileEdit>()

/** Conflict window: edits within this period trigger a warning (5 minutes) */
const CONFLICT_WINDOW = 5 * 60 * 1000

/**
 * Subscribe to session.diff events and detect file conflicts.
 * Called during bootstrap when OPENCODE_EXPERIMENTAL_AGENT_TEAMS is enabled.
 */
export function initFileTracking(): () => void {
  return Bus.subscribe(Session.Event.Diff, async (event) => {
    const sessionID = event.properties.sessionID
    const files = event.properties.diff

    // Find which team this session belongs to
    const info = await Team.findBySession(sessionID).catch(() => undefined)
    if (!info) return
    if (info.role !== "member" || !info.memberName) return

    const now = Date.now()
    const teamName = info.team.name
    const editor = info.memberName

    for (const file of files) {
      const prev = edits.get(file.file)

      // Check for conflict: different member edited within window
      if (prev && prev.memberName !== editor && now - prev.timestamp < CONFLICT_WINDOW) {
        log.warn("file conflict detected", {
          teamName,
          filepath: file.file,
          editor,
          previous: prev.memberName,
        })

        await Bus.publish(TeamEvent.FileConflict, {
          teamName,
          filepath: file.file,
          members: [prev.memberName, editor],
        })

        // Notify both teammates and the lead
        const warning = `[System]: File conflict — both '${prev.memberName}' and '${editor}' edited ${file.file} within ${Math.round(CONFLICT_WINDOW / 60000)} minutes. Coordinate to avoid overwriting each other's changes.`

        await TeamMessaging.send({ teamName, from: "system", to: prev.memberName, text: warning }).catch(() => {})
        await TeamMessaging.send({ teamName, from: "system", to: editor, text: warning }).catch(() => {})
        await TeamMessaging.send({ teamName, from: "system", to: "lead", text: warning }).catch(() => {})
      }

      // Track this edit
      edits.set(file.file, { memberName: editor, sessionID, timestamp: now })
    }
  })
}

/**
 * Get all recent file edits tracked for a team.
 * Used by team_status to show file ownership.
 */
export function recentEdits(teamName: string): Array<{ file: string; memberName: string; timestamp: number }> {
  const now = Date.now()
  const result: Array<{ file: string; memberName: string; timestamp: number }> = []
  for (const [file, edit] of edits) {
    if (now - edit.timestamp < CONFLICT_WINDOW) {
      result.push({ file, memberName: edit.memberName, timestamp: edit.timestamp })
    }
  }
  return result
}

/**
 * Get active file conflicts (files edited by multiple members within window).
 */
export function activeConflicts(): Array<{ file: string; members: string[] }> {
  const now = Date.now()
  const byFile = new Map<string, string[]>()

  for (const [file, edit] of edits) {
    if (now - edit.timestamp >= CONFLICT_WINDOW) continue
    const existing = byFile.get(file) ?? []
    if (!existing.includes(edit.memberName)) existing.push(edit.memberName)
    byFile.set(file, existing)
  }

  return [...byFile.entries()]
    .filter(([_, members]) => members.length > 1)
    .map(([file, members]) => ({ file, members }))
}
