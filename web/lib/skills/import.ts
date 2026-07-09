import "server-only"

import { TextDecoder } from "node:util"
import matter from "gray-matter"
import { fromBufferPromise, type Entry } from "yauzl"
import * as z from "zod"
import { type SkillWrite, skillNameSchema } from "@/lib/skills/storage"

export const maxUploadBytes = 10 * 1024 * 1024
const maxExtractedBytes = 20 * 1024 * 1024
const maxSkillBytes = 64 * 1024
const maxFileBytes = 1024 * 1024
const maxFileCount = 200
const skillFileName = "SKILL.md"

const decoder = new TextDecoder("utf-8", { fatal: true })

const frontmatterNameSchema = z
  .string({ error: "frontmatter.name must be a string" })
  .min(1, "frontmatter.name must be 1-64 characters")
  .max(64, "frontmatter.name must be 1-64 characters")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "frontmatter.name is invalid")

const skillFrontmatterSchema = z
  .object({
    name: frontmatterNameSchema,
    description: z
      .string({ error: "frontmatter.description must be a string" })
      .max(1024, "frontmatter.description must be at most 1024 characters")
      .refine((value) => value.trim().length > 0, "frontmatter.description is required"),
  })
  .passthrough()

type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>

export type ImportDecision =
  | {
      action: "create" | "overwrite"
      name: string
    }
  | {
      action: "rename"
      name: string
      rename: string
    }

export const importDecisionsSchema = z.array(
  z.discriminatedUnion("action", [
    z.object({
      action: z.literal("create"),
      name: skillNameSchema,
    }),
    z.object({
      action: z.literal("overwrite"),
      name: skillNameSchema,
    }),
    z.object({
      action: z.literal("rename"),
      name: skillNameSchema,
      rename: skillNameSchema,
    }),
  ])
)

export async function skillsFromUpload(fileName: string, bytes: Buffer): Promise<SkillWrite[]> {
  if (bytes.length > maxUploadBytes) {
    throw new Error("import file is too large")
  }
  if (fileName.endsWith(".md")) {
    return [skillFromMarkdown(bytes)]
  }
  if (fileName.endsWith(".zip")) {
    return skillsFromZip(bytes)
  }
  throw new Error("import file must be .md or .zip")
}

export function skillsForApply(skills: SkillWrite[], decisions: ImportDecision[]): SkillWrite[] {
  const byName = new Map(skills.map((skill) => [skill.name, skill]))
  const out: SkillWrite[] = []
  const seen = new Set<string>()

  for (const decision of decisions) {
    const skill = byName.get(decision.name)
    if (!skill) {
      throw new Error("import decision references an unknown skill")
    }
    const name = skillNameSchema.parse(
      decision.action === "rename" ? decision.rename : decision.name
    )
    if (seen.has(name)) {
      throw new Error("import contains duplicate destination names")
    }
    seen.add(name)
    out.push({ name, files: skill.files })
  }

  if (out.length !== skills.length) {
    throw new Error("import decisions are incomplete")
  }
  return out
}

function skillFromMarkdown(bytes: Buffer): SkillWrite {
  const frontmatter = parseSkillFile(bytes)
  return {
    name: frontmatter.name,
    files: [
      {
        path: skillFileName,
        content: bytes,
      },
    ],
  }
}

async function skillsFromZip(bytes: Buffer): Promise<SkillWrite[]> {
  const zip = await fromBufferPromise(bytes, {
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  })
  const skills = new Map<string, Map<string, Buffer>>()
  const paths = new Set<string>()
  let extractedBytes = 0
  let fileCount = 0

  try {
    for await (const entry of zip.eachEntry()) {
      const path = zipFilePath(entry)
      if (!path) {
        continue
      }
      fileCount += 1
      if (fileCount > maxFileCount) {
        throw new Error("import contains too many files")
      }
      extractedBytes += entry.uncompressedSize
      if (extractedBytes > maxExtractedBytes) {
        throw new Error("import expands to too much data")
      }

      const key = `${path.skillName}/${path.filePath}`
      if (paths.has(key)) {
        throw new Error("import contains duplicate file paths")
      }
      paths.add(key)

      const sizeLimit = path.filePath === skillFileName ? maxSkillBytes : maxFileBytes
      if (entry.uncompressedSize > sizeLimit) {
        throw new Error(`${key} is too large`)
      }

      const files = skills.get(path.skillName) ?? new Map<string, Buffer>()
      files.set(path.filePath, await readEntry(zip, entry, sizeLimit))
      skills.set(path.skillName, files)
    }
  } finally {
    zip.close()
  }

  const out: SkillWrite[] = []
  for (const [name, files] of skills) {
    const skillFile = files.get(skillFileName)
    if (!skillFile) {
      throw new Error(`${name} is missing SKILL.md`)
    }
    const frontmatter = parseSkillFile(skillFile)
    if (frontmatter.name !== name) {
      throw new Error(`${name} frontmatter.name must match its directory`)
    }
    out.push({
      name,
      files: [...files].map(([path, content]) => ({ path, content })),
    })
  }
  if (out.length === 0) {
    throw new Error("import contains no skills")
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function parseSkillFile(bytes: Buffer): SkillFrontmatter {
  if (bytes.length > maxSkillBytes) {
    throw new Error("SKILL.md is too large")
  }

  let text: string
  try {
    text = decoder.decode(bytes)
  } catch {
    throw new Error("SKILL.md must be utf-8")
  }
  if (!matter.test(text)) {
    throw new Error("skill frontmatter is required")
  }

  const doc = matter(text)
  if (doc.content.trim().length === 0) {
    throw new Error("skill body is required")
  }

  const frontmatter = skillFrontmatterSchema.safeParse(doc.data)
  if (!frontmatter.success) {
    throw new Error(frontmatter.error.issues.map((issue) => issue.message).join("; "))
  }
  return frontmatter.data
}

function zipFilePath(entry: Entry): { skillName: string; filePath: string } | undefined {
  if (entry.isEncrypted()) {
    throw new Error("encrypted zip entries are not supported")
  }
  if (!entry.canDecodeFileData()) {
    throw new Error("zip entry encoding is not supported")
  }
  if (isZipSymlink(entry)) {
    throw new Error("zip symlinks are not supported")
  }

  const raw = entry.fileName
  if (raw.includes("\\") || raw.includes("\0") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw new Error("zip entry path is invalid")
  }

  const directoryPath = raw.endsWith("/") ? raw.slice(0, -1) : raw
  const parts = directoryPath.split("/")
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error("zip entry path is invalid")
  }
  if (raw.endsWith("/")) {
    return
  }
  if (parts.length < 2) {
    throw new Error("zip entries must be inside skill directories")
  }

  return {
    skillName: skillNameSchema.parse(parts[0]),
    filePath: parts.slice(1).join("/"),
  }
}

function isZipSymlink(entry: Entry): boolean {
  const unixMode = entry.externalFileAttributes >>> 16
  return (unixMode & 0o170000) === 0o120000
}

async function readEntry(
  zip: Awaited<ReturnType<typeof fromBufferPromise>>,
  entry: Entry,
  limit: number
) {
  const stream = await zip.openReadStreamPromise(entry)
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of stream) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk
    size += buffer.length
    if (size > limit) {
      throw new Error(`${entry.fileName} is too large`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}
