import { describe, expect, test } from "bun:test"
import { targets } from "../../../src/cli/cmd/tui/context/team-sync"

describe("team sync", () => {
  test("snapshots ids before sync reorders the map", () => {
    const map = new Map([["ses_1", 1]])
    const seen: string[] = []

    for (const id of targets(map.keys(), {}, undefined)) {
      seen.push(id)
      const value = map.get(id)
      expect(value).toBeDefined()
      map.delete(id)
      map.set(id, value! + 1)
    }

    expect(seen).toEqual(["ses_1"])
  })

  test("filters ids by team name", () => {
    expect(
      targets(
        ["ses_1", "ses_2", "ses_3"],
        {
          ses_1: { teamName: "alpha" },
          ses_2: { teamName: "beta" },
        },
        "alpha",
      ),
    ).toEqual(["ses_1", "ses_3"])
  })
})
