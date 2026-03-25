import type { Message } from "@opencode-ai/sdk/v2"

function stamp(msg: Message) {
  if (msg.role !== "assistant") return msg.time.created
  return msg.time.completed ?? Infinity
}

export function timeline<T extends Message>(list: readonly T[]) {
  return list
    .map((msg, idx) => ({ msg, idx }))
    .toSorted((a, b) => {
      const diff = stamp(a.msg) - stamp(b.msg)
      if (diff !== 0) return diff
      return a.idx - b.idx
    })
    .map((item) => item.msg)
}
