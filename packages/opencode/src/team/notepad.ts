import { Log } from "../util/log"
import { Storage } from "../storage/storage"
import { Instance } from "../project/instance"

const log = Log.create({ service: "team.notepad" })

function key(teamName: string): string[] {
  return ["team_notepad", Instance.project.id, teamName]
}

type NotepadData = Record<string, string>

export namespace TeamNotepad {
  /**
   * Read all notepad entries for a team.
   */
  export async function list(teamName: string): Promise<NotepadData> {
    try {
      return await Storage.read<NotepadData>(key(teamName))
    } catch {
      return {}
    }
  }

  /**
   * Read a single notepad entry.
   */
  export async function read(teamName: string, entry: string): Promise<string | undefined> {
    const data = await list(teamName)
    return data[entry]
  }

  /**
   * Write a notepad entry. Creates or overwrites.
   */
  export async function write(teamName: string, entry: string, value: string): Promise<void> {
    try {
      await Storage.update<NotepadData>(key(teamName), (draft) => {
        draft[entry] = value
      })
    } catch {
      // First write — create the storage key
      await Storage.write(key(teamName), { [entry]: value })
    }
    log.info("notepad write", { teamName, entry, length: value.length })
  }

  /**
   * Delete a notepad entry.
   */
  export async function remove(teamName: string, entry: string): Promise<void> {
    try {
      await Storage.update<NotepadData>(key(teamName), (draft) => {
        delete draft[entry]
      })
    } catch {
      // Not found — ignore
    }
  }

  /**
   * Remove all notepad data for a team.
   */
  export async function removeAll(teamName: string): Promise<void> {
    try {
      await Storage.remove(key(teamName))
    } catch {
      // Not found — ignore
    }
  }

  /**
   * Format notepad contents for injection into teammate context.
   */
  export async function context(teamName: string): Promise<string> {
    const data = await list(teamName)
    const entries = Object.entries(data)
    if (entries.length === 0) return ""
    return [
      "Team notepad (shared knowledge):",
      ...entries.map(([k, v]) => `  [${k}]: ${v}`),
      "",
    ].join("\n")
  }
}
