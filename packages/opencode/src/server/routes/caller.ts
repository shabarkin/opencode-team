import type { Context } from "hono"
import { SessionID } from "@/session/schema"

export function caller(c: Context) {
  const raw = c.req.header("x-opencode-session")
  if (!raw) return
  const result = SessionID.zod.safeParse(raw)
  if (!result.success) return
  return result.data
}
