import path from "path"
import { Instance } from "@/project/instance"
import { Filesystem } from "@/util/filesystem"

function norm(input: string) {
  return input.replaceAll("\\", "/")
}

export function permPath(file: string, opts?: { dir?: string; root?: string }) {
  const dir = opts?.dir ?? Instance.directory
  const root = opts?.root ?? Instance.worktree
  const full = path.resolve(file)
  if (Filesystem.contains(dir, full)) return norm(path.relative(dir, full) || ".")
  if (root !== "/" && Filesystem.contains(root, full)) return norm(path.relative(root, full) || ".")
  return norm(full)
}

export function permGlob(dir: string) {
  return norm(path.join(dir, "**"))
}
