import { Log } from "../util/log"
import { Bus } from "../bus"
import { Session } from "../session"
import { Team, TeamEvent } from "./index"
import { TeamMessaging } from "./messaging"

const log = Log.create({ service: "team.files" })

function closing(status?: string) {
  return status === "shutdown" || status === "shutdown_requested"
}

function shutdowns(team?: { members: Array<{ name: string; status: string }> }) {
  return new Set((team?.members ?? []).filter((m) => closing(m.status)).map((m) => m.name))
}

/** Tracks which team member last edited a file and when */
interface FileEdit {
  teamName: string
  memberName: string
  sessionID: string
  timestamp: number
}

/** In-memory map: team:file → recent editors */
const edits = new Map<string, FileEdit[]>()
const warns = new Map<string, number>()

/** Conflict window: edits within this period trigger a warning (5 minutes) */
const CONFLICT_WINDOW = 5 * 60 * 1000
const CONFLICT_COOLDOWN = 60_000

function key(teamName: string, file: string): string {
  return `${teamName}:${file}`
}

function file(key: string): string {
  return key.slice(key.indexOf(":") + 1)
}

function recent(list: FileEdit[], now: number) {
  return list.filter((edit) => now - edit.timestamp < CONFLICT_WINDOW)
}

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
    const team = await Team.get(teamName)
    if (!team) return
    const skip = shutdowns(team)
    if (skip.has(editor)) return

    for (const file of files) {
      const id = key(teamName, file.file)
      const prev = recent(edits.get(id) ?? [], now).filter((edit) => !skip.has(edit.memberName))
      const members = [...new Set(prev.map((edit) => edit.memberName).filter((name) => name !== editor))]

      // Check for conflict: different member edited within window
      if (members.length > 0 && now - (warns.get(id) ?? 0) >= CONFLICT_COOLDOWN) {
        warns.set(id, now)
        log.warn("file conflict detected", {
          teamName,
          filepath: file.file,
          editor,
          previous: members,
        })

        await Bus.publish(TeamEvent.FileConflict, {
          teamName,
          filepath: file.file,
          members: [...members, editor],
        })

        // Notify both teammates and the lead
        const warning = `[System]: File conflict — ${[...members, editor].join(", ")} edited ${file.file} within ${Math.round(CONFLICT_WINDOW / 60000)} minutes. Coordinate to avoid overwriting each other's changes.`

        for (const member of members) {
          if (skip.has(member)) continue
          await TeamMessaging.send({ teamName, from: "system", to: member, text: warning }).catch(() => {})
        }
        if (!skip.has(editor)) {
          await TeamMessaging.send({ teamName, from: "system", to: editor, text: warning }).catch(() => {})
        }
        await TeamMessaging.send({ teamName, from: "system", to: "lead", text: warning }).catch(() => {})
      }

      // Track this edit
      edits.set(id, [
        ...prev.filter((edit) => edit.memberName !== editor),
        { teamName, memberName: editor, sessionID, timestamp: now },
      ])
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
  for (const [id, list] of edits) {
    const next = recent(list, now)
    if (next.length === 0) {
      edits.delete(id)
      warns.delete(id)
      continue
    }
    edits.set(id, next)
    const edit = next.findLast((edit) => edit.teamName === teamName)
    if (!edit) continue
    result.push({ file: file(id), memberName: edit.memberName, timestamp: edit.timestamp })
  }
  return result
}

/**
 * Get active file conflicts (files edited by multiple members within window).
 */
export function activeConflicts(
  teamName: string,
  team?: { members: Array<{ name: string; status: string }> },
): Array<{ file: string; members: string[] }> {
  const now = Date.now()
  const result: Array<{ file: string; members: string[] }> = []
  const skip = shutdowns(team)

  for (const [id, list] of edits) {
    const next = recent(list, now)
    if (next.length === 0) {
      edits.delete(id)
      warns.delete(id)
      continue
    }
    edits.set(id, next)
    const members = [
      ...new Set(next.filter((edit) => edit.teamName === teamName).map((edit) => edit.memberName)),
    ].filter((name) => !skip.has(name))
    if (members.length < 2) continue
    result.push({ file: file(id), members })
  }

  return result
}

export function removeEdits(teamName: string) {
  for (const id of edits.keys()) {
    if (!id.startsWith(`${teamName}:`)) continue
    edits.delete(id)
    warns.delete(id)
  }
}
