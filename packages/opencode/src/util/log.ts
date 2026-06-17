type Fields = Record<string, unknown>

export function init(_input?: { print?: boolean }) {
  return
}

function write(level: "debug" | "info" | "warn" | "error", service: string, message: string, fields?: Fields) {
  if (process.env.OPENCODE_PRINT_LOGS !== "1") return
  console[level](`[${service}] ${message}`, fields ?? {})
}

export function create(input: { service: string }) {
  return {
    debug(message: string, fields?: Fields) {
      write("debug", input.service, message, fields)
    },
    info(message: string, fields?: Fields) {
      write("info", input.service, message, fields)
    },
    warn(message: string, fields?: Fields) {
      write("warn", input.service, message, fields)
    },
    error(message: string, fields?: Fields) {
      write("error", input.service, message, fields)
    },
  }
}
