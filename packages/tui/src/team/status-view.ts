export function teamStatusIcon(status: string): string {
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
    case "error":
      return "E"
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
