import type { Context } from "hono"
import { SessionID } from "@/session/schema"

export function caller(c: Context) {
  const raw = c.req.header("x-opencode-session")
  if (!raw) return
  try {
    return SessionID.make(raw)
  } catch {
    return
  }
}
