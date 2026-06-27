import matter from "gray-matter"
import fs from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

export type SkillRecord = {
  name: string
  description: string
  content: string
  location: string
  baseDir: string
  scope: "project" | "global"
  root: string
}

type SkillFrontmatter = {
  name: string
  description: string
}

const ignoredDirectories = new Set([".git", "node_modules"])
const globalHome = homedir()

function ancestorDirectories(directory: string, worktree: string): string[] {
  const current = path.resolve(directory)
  const stop = path.resolve(worktree)

  if (current !== stop && !current.startsWith(`${stop}${path.sep}`)) {
    return [current]
  }

  const directories: string[] = []
  let cursor = current

  for (;;) {
    directories.push(cursor)
    if (cursor === stop) {
      break
    }
    const parent = path.dirname(cursor)
    if (parent === cursor) {
      break
    }
    cursor = parent
  }

  return directories
}

function skillRoots(
  directory: string,
  worktree: string
): Array<{ root: string; scope: "project" | "global" }> {
  const roots: Array<{ root: string; scope: "project" | "global" }> = [
    { root: path.join(globalHome, ".claude", "skills"), scope: "global" as const },
    { root: path.join(globalHome, ".agents", "skills"), scope: "global" as const },
  ]

  for (const ancestor of ancestorDirectories(directory, worktree)) {
    roots.push({ root: path.join(ancestor, ".claude", "skills"), scope: "project" as const })
    roots.push({ root: path.join(ancestor, ".agents", "skills"), scope: "project" as const })
  }

  roots.push({
    root: path.join(globalHome, ".config", "opencode", "skills"),
    scope: "global" as const,
  })

  for (const ancestor of ancestorDirectories(directory, worktree)) {
    roots.push({ root: path.join(ancestor, ".opencode", "skills"), scope: "project" as const })
  }

  return roots
}

function hasSkillFrontmatter(data: unknown): data is SkillFrontmatter {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return false
  }

  const record = data as Record<string, unknown>
  return typeof record.name === "string" && typeof record.description === "string"
}

async function collectSkillFiles(root: string): Promise<string[]> {
  const entries = (await fs.readdir(root, { withFileTypes: true }).catch(() => [])).sort(
    (left, right) => left.name.localeCompare(right.name)
  )
  const files: string[] = []

  for (const entry of entries) {
    if (entry.isSymbolicLink() || ignoredDirectories.has(entry.name)) {
      continue
    }

    const next = path.join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectSkillFiles(next)))
      continue
    }

    if (entry.isFile() && entry.name === "SKILL.md") {
      files.push(next)
    }
  }

  return files
}

async function readSkillFile(
  file: string,
  scope: "project" | "global",
  root: string
): Promise<SkillRecord | undefined> {
  const raw = await fs.readFile(file, "utf8").catch(() => undefined)
  if (!raw) {
    return
  }

  let parsed: matter.GrayMatterFile<string>
  try {
    parsed = matter(raw)
  } catch {
    return
  }

  if (!hasSkillFrontmatter(parsed.data)) {
    return
  }

  return {
    name: parsed.data.name,
    description: parsed.data.description,
    content: parsed.content,
    location: file,
    baseDir: path.dirname(file),
    scope,
    root,
  }
}

export async function listSkills(directory: string, worktree: string): Promise<SkillRecord[]> {
  const skills = new Map<string, SkillRecord>()

  for (const item of skillRoots(directory, worktree)) {
    const files = await collectSkillFiles(item.root)

    for (const file of files) {
      const skill = await readSkillFile(file, item.scope, item.root)
      if (!skill) {
        continue
      }
      skills.set(skill.name, skill)
    }
  }

  return Array.from(skills.values()).sort((left, right) => left.name.localeCompare(right.name))
}

export async function listSkillFiles(baseDir: string, limit: number): Promise<string[]> {
  const entries = (await fs.readdir(baseDir, { withFileTypes: true }).catch(() => [])).sort(
    (left, right) => left.name.localeCompare(right.name)
  )
  const files: string[] = []

  for (const entry of entries) {
    if (files.length >= limit) {
      break
    }

    if (entry.isSymbolicLink() || ignoredDirectories.has(entry.name)) {
      continue
    }

    const next = path.join(baseDir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listSkillFiles(next, limit - files.length)))
      continue
    }

    if (entry.isFile() && entry.name !== "SKILL.md") {
      files.push(next)
    }
  }

  return files
}
