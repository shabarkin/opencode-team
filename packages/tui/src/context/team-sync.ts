type Info = {
  teamName: string
}

export function targets(ids: Iterable<string>, team: Record<string, Info | undefined>, name?: string) {
  return [...ids].filter((id) => {
    if (!name) return true
    const info = team[id]
    if (!info) return true
    return info.teamName === name
  })
}
