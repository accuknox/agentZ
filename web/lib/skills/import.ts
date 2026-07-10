import "server-only"

import { TextDecoder } from "node:util"
import matter from "gray-matter"
import { fromBufferPromise, type Entry, type Options, type ZipFile } from "yauzl"
import * as z from "zod"
import { type SkillWrite, skillNameSchema } from "@/lib/skills/storage"

export const maxUploadBytes = 10 * 1024 * 1024
const maxExtractedBytes = 20 * 1024 * 1024
const maxSkillBytes = 64 * 1024
const maxFileBytes = 1024 * 1024
const maxFileCount = 200
const skillFileName = "SKILL.md"
const skillFileSuffix = `/${skillFileName}`
const zipOptions: Options = {
  lazyEntries: true,
  strictFileNames: true,
  validateEntrySizes: true,
}

const decoder = new TextDecoder("utf-8", { fatal: true })

const frontmatterNameSchema = z
  .string({ error: "frontmatter.name must be a string" })
  .min(1, "frontmatter.name must be 1-32 characters")
  .max(32, "frontmatter.name must be 1-32 characters")
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

type ZipEntry = {
  path: string
  content: Buffer
}

type ZipFileEntry = {
  path: string
  sizeLimit: number
}

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

export function jsonFormField<T>(schema: z.ZodType<T>) {
  return z
    .string()
    .transform((value, ctx) => {
      try {
        return JSON.parse(value) as unknown
      } catch {
        ctx.addIssue({ code: "custom", message: "invalid JSON" })
        return z.NEVER
      }
    })
    .pipe(schema)
}

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
    out.push({ name, description: skill.description, files: skill.files })
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
    description: frontmatter.description,
    files: [
      {
        path: skillFileName,
        content: bytes,
      },
    ],
  }
}

async function skillsFromZip(bytes: Buffer): Promise<SkillWrite[]> {
  const zip = await fromBufferPromise(bytes, zipOptions)
  const entries: ZipFileEntry[] = []
  const roots = new Set<string>()
  const seen = new Set<string>()
  let extractedBytes = 0
  let fileCount = 0

  try {
    for await (const entry of zip.eachEntry()) {
      const path = skillArchivePath(entry)
      if (path === undefined) {
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

      if (seen.has(path)) {
        throw new Error("import contains duplicate file paths")
      }
      seen.add(path)

      const sizeLimit =
        path.endsWith(skillFileSuffix) || path === skillFileName ? maxSkillBytes : maxFileBytes
      if (entry.uncompressedSize > sizeLimit) {
        throw new Error(`${path} is too large`)
      }

      if (path === skillFileName) {
        roots.add("")
      } else if (path.endsWith(skillFileSuffix)) {
        roots.add(path.slice(0, -skillFileSuffix.length))
      }
      entries.push({ path, sizeLimit })
    }
  } finally {
    zip.close()
  }

  if (roots.size === 0) {
    throw new Error("import contains no skills")
  }

  const sortedRoots = [...roots].sort((a, b) => a.length - b.length)
  for (const [index, root] of sortedRoots.entries()) {
    const nestedRoot = sortedRoots
      .slice(index + 1)
      .find((item) => root === "" || item.startsWith(`${root}/`))
    if (nestedRoot !== undefined) {
      throw new Error("import contains nested skill directories")
    }
  }

  const out: SkillWrite[] = []
  const filesByRoot = new Map(sortedRoots.map((root) => [root, [] as ZipEntry[]]))
  const imported = new Map<string, { root: string; path: string; sizeLimit: number }>()
  for (const root of sortedRoots) {
    for (const entry of entries) {
      if (root !== "" && !entry.path.startsWith(`${root}/`)) {
        continue
      }

      imported.set(entry.path, {
        root,
        path: root === "" ? entry.path : entry.path.slice(root.length + 1),
        sizeLimit: entry.sizeLimit,
      })
    }
  }

  const readZip = await fromBufferPromise(bytes, zipOptions)
  try {
    for await (const entry of readZip.eachEntry()) {
      const path = skillArchivePath(entry)
      if (path === undefined) {
        continue
      }

      const importedFile = imported.get(path)
      if (importedFile === undefined) {
        continue
      }

      const rootFiles = filesByRoot.get(importedFile.root)
      if (rootFiles === undefined) {
        throw new Error("import contains an invalid skill directory")
      }
      rootFiles.push({
        path: importedFile.path,
        content: await readEntry(readZip, entry, importedFile.sizeLimit),
      })
    }
  } finally {
    readZip.close()
  }

  const names = new Set<string>()
  for (const root of sortedRoots) {
    const skillFiles = filesByRoot.get(root)
    if (skillFiles === undefined) {
      throw new Error("import contains an invalid skill directory")
    }

    const skillFile = skillFiles.find((file) => file.path === skillFileName)?.content
    if (skillFile === undefined) {
      throw new Error("import contains an invalid skill directory")
    }

    const frontmatter = parseSkillFile(skillFile)
    if (names.has(frontmatter.name)) {
      throw new Error("import contains duplicate skill names")
    }
    names.add(frontmatter.name)

    out.push({
      name: frontmatter.name,
      description: frontmatter.description,
      files: skillFiles,
    })
  }

  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function skillArchivePath(entry: Entry): string | undefined {
  if (entry.isEncrypted()) {
    throw new Error("encrypted zip entries are not supported")
  }
  if (!entry.canDecodeFileData()) {
    throw new Error("zip entry encoding is not supported")
  }

  const unixMode = entry.externalFileAttributes >>> 16
  if ((unixMode & 0o170000) === 0o120000) {
    throw new Error("zip symlinks are not supported")
  }

  const raw = entry.fileName
  const path = raw.endsWith("/") ? raw.slice(0, -1) : raw
  const parts = path.split("/")
  if (
    raw.includes("\0") ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error("zip entry path is invalid")
  }

  if (raw.endsWith("/")) {
    return
  }
  return parts.join("/")
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

async function readEntry(zip: ZipFile, entry: Entry, limit: number): Promise<Buffer> {
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
