import { Log } from "../util"
import { Bus } from "../bus"
import { File } from "../file"
import { Team, TeamEvent } from "./index"
import { TeamMessaging } from "./messaging"
import { TeamPolicy } from "./policy"

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
const SEP = "\u0000"
const SHARED = "shared"
let sweeps = 0

/** Conflict window: edits within this period trigger a warning (5 minutes) */
const CONFLICT_WINDOW = 5 * 60 * 1000
const CONFLICT_COOLDOWN = 60_000

function base(member?: { worktreePath?: string }) {
  return member?.worktreePath ?? SHARED
}

function key(teamName: string, dir: string, file: string): string {
  return [teamName, dir, file].join(SEP)
}

function part(id: string) {
  const [teamName, dir, file] = id.split(SEP)
  return { teamName, dir, file }
}

function recent(list: FileEdit[], now: number) {
  return list.filter((edit) => now - edit.timestamp < CONFLICT_WINDOW)
}

function sweep(now: number) {
  for (const [id, list] of edits) {
    if (recent(list, now).length > 0) continue
    edits.delete(id)
    warns.delete(id)
  }
}

/**
 * Subscribe to file.edited events and detect file conflicts.
 * Called during bootstrap when OPENCODE_EXPERIMENTAL_AGENT_TEAMS is enabled.
 */
export function initFileTracking(): () => void {
  return Bus.subscribe(File.Event.Edited, async (event) => {
    const sessionID = event.properties.sessionID
    const file = event.properties.file
    if (!sessionID) return

    // Find which team this session belongs to
    const info = await Team.findBySession(sessionID).catch(() => undefined)
    if (!info) return
    if (info.role !== "member" || !info.memberName) return

    const now = Date.now()
    sweeps += 1
    if (sweeps % 64 === 0) sweep(now)
    const teamName = info.team.name
    const editor = info.memberName
    const team = info.team
    const skip = shutdowns(team)
    if (skip.has(editor)) return
    const member = team.members.find((item) => item.name === editor)
    if (!member) return

    const id = key(teamName, base(member), file)
    const prev = recent(edits.get(id) ?? [], now).filter((edit) => !skip.has(edit.memberName))
    const members = [...new Set(prev.map((edit) => edit.memberName).filter((name) => name !== editor))]

    // Check for conflict: different member edited within window
    if (members.length > 0 && now - (warns.get(id) ?? 0) >= CONFLICT_COOLDOWN) {
      warns.set(id, now)
      log.warn("file conflict detected", {
        teamName,
        filepath: file,
        editor,
        previous: members,
      })

      await Bus.publish(TeamEvent.FileConflict, {
        teamName,
        filepath: file,
        members: [...members, editor],
      })

      const action = await TeamPolicy.conflictDetected({
        teamName,
        file,
        editors: [...members, editor],
      })
      if (action.action !== "ignore") {
        // Notify both teammates and the lead
        const warning = `[System]: File conflict — ${[...members, editor].join(", ")} edited ${file} within ${Math.round(CONFLICT_WINDOW / 60000)} minutes. ${action.action === "block" ? "Work has been paused until the lead resolves the conflict." : "Coordinate to avoid overwriting each other's changes."}`

        if (action.action === "block") {
          for (const name of [...members, editor]) {
            if (skip.has(name)) continue
            await Team.pause({ teamName, memberName: name }).catch(() => {})
          }
        }

        for (const member of members) {
          if (skip.has(member)) continue
          await TeamMessaging.send({ teamName, from: "system", to: member, text: warning }).catch(() => {})
        }
        if (!skip.has(editor)) {
          await TeamMessaging.send({ teamName, from: "system", to: editor, text: warning }).catch(() => {})
        }
        await TeamMessaging.send({ teamName, from: "system", to: "lead", text: warning }).catch(() => {})
      }
    }

    // Track this edit
    edits.set(id, [
      ...prev.filter((edit) => edit.memberName !== editor),
      { teamName, memberName: editor, sessionID, timestamp: now },
    ])
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
    const item = part(id)
    if (item.teamName !== teamName) continue
    const next = recent(list, now)
    if (next.length === 0) {
      edits.delete(id)
      warns.delete(id)
      continue
    }
    edits.set(id, next)
    const edit = next.findLast(() => true)
    if (!edit) continue
    result.push({ file: item.file, memberName: edit.memberName, timestamp: edit.timestamp })
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
    const item = part(id)
    if (item.teamName !== teamName) continue
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
    result.push({ file: item.file, members })
  }

  return result
}

export function removeEdits(teamName: string) {
  for (const id of edits.keys()) {
    if (part(id).teamName !== teamName) continue
    edits.delete(id)
    warns.delete(id)
  }
}
