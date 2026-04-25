import path from "path"
import * as Wildcard from "../util/wildcard"
import type { TeamScope as Scope } from "./events"

export const DEFAULT_EXCLUDES = [".ananke/**", ".claude/**", ".opencode/**", ".git/**", "node_modules/**"]

function norm(input: string) {
  return input.replaceAll("\\", "/")
}

function rel(file: string, cwd: string) {
  return norm(path.relative(cwd, path.resolve(cwd, file))) || "."
}

function abs(file: string, cwd: string) {
  return norm(path.resolve(cwd, file))
}

function match(file: string, rule: string, cwd: string) {
  return path.isAbsolute(rule) ? Wildcard.match(abs(file, cwd), norm(rule)) : Wildcard.match(rel(file, cwd), norm(rule))
}

export namespace TeamScope {
  export function withDefaults(scope?: Scope): Scope {
    return {
      ...(scope ?? {}),
      path_excludes: [...new Set([...DEFAULT_EXCLUDES, ...(scope?.path_excludes ?? [])])],
    }
  }

  /**
   * Member scope narrows includes and bash rules, while excludes accumulate.
   */
  export function merge(team?: Scope, member?: Scope): Scope {
    return {
      ...(team ?? {}),
      ...(member ?? {}),
      path_excludes: [...(team?.path_excludes ?? []), ...(member?.path_excludes ?? [])],
      path_includes: member?.path_includes ?? team?.path_includes,
      bash_allowlist: member?.bash_allowlist ?? team?.bash_allowlist,
    }
  }

  export function checkPath(filePath: string, scope: Scope, cwd: string): { allow: boolean; reason?: string } {
    const deny = scope.path_excludes?.find((item) => match(filePath, item, cwd))
    if (deny) {
      return {
        allow: false,
        reason: `Path is excluded by team scope: ${deny}`,
      }
    }

    if (!scope.path_includes?.length) return { allow: true }
    if (scope.path_includes.some((item) => match(filePath, item, cwd))) return { allow: true }
    return {
      allow: false,
      reason: `Path is outside the allowed team scope for ${rel(filePath, cwd)}`,
    }
  }

  export function checkBashCommand(cmd: string, scope: Scope): { allow: boolean; reason?: string } {
    if (!scope.bash_allowlist?.length) return { allow: true }
    if (scope.bash_allowlist.some((item) => Wildcard.match(cmd, item))) return { allow: true }
    return {
      allow: false,
      reason: `Bash command is outside the allowed team scope: ${cmd}`,
    }
  }
}
