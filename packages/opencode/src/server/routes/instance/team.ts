import { Server } from "@/server/server"
import { Instance } from "@/project/instance"

function initWithDirectory(init?: RequestInit): RequestInit | undefined {
  let directory: string | undefined
  try {
    directory = Instance.directory
  } catch {
    return init
  }
  const headers = new Headers(init?.headers)
  if (!headers.has("x-opencode-directory")) headers.set("x-opencode-directory", directory)
  return {
    ...init,
    headers,
  }
}

function requestWithDirectory(input: Request, init?: RequestInit) {
  const url = new URL(input.url)
  normalize(url)
  return new Request(
    new Request(url, input),
    initWithDirectory({
      ...init,
      headers: init?.headers ?? input.headers,
    }),
  )
}

function normalize(url: URL) {
  if (url.pathname === "/") url.pathname = "/team"
  else if (url.pathname !== "/team" && !url.pathname.startsWith("/team/")) url.pathname = `/team${url.pathname}`
  return url
}

function routeInput(input: string | URL) {
  if (input instanceof URL) return normalize(new URL(input))
  const url = input.toString()
  return url === "/" ? "/team" : `/team${url}`
}

export const TeamRoutes = () => ({
  request(input: string | URL | Request, init?: RequestInit) {
    if (input instanceof Request) return Server.Default().app.request(requestWithDirectory(input, init))
    return Server.Default().app.request(routeInput(input), initWithDirectory(init))
  },
})
