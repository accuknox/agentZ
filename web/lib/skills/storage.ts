import "server-only"

import { Readable } from "node:stream"
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import type { NodeJsClient } from "@smithy/types"
import { ZipFile } from "yazl"
import * as z from "zod"
import { zSkillName } from "@/lib/gateway/client/zod.gen"
import { getEnv } from "@/lib/env"

const deleteBatchSize = 1000
const defaultListLimit = 50
const maxListLimit = 200

export const skillNameSchema = zSkillName

export const skillNamesSchema = z
  .array(skillNameSchema, { error: "Skills must be a list" })
  .min(1, "Select at least one skill")
  .max(200, "Select at most 200 skills")
  .refine((names) => new Set(names).size === names.length, "Skills must be unique")

export const skillVersionSchema = z
  .number({ error: "Version must be a number" })
  .int("Version must be a whole number")
  .min(1, "Version must be at least 1")
  .max(Number.MAX_SAFE_INTEGER, "Version is too large")

const homeStoragePrefixSchema = z
  .string({ error: "Agent home is not ready" })
  .trim()
  .min(1, "Agent home is not ready")
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Agent home storage prefix is invalid")

const tenantNamespaceSchema = z
  .string({ error: "Tenant namespace is required" })
  .trim()
  .min(1, "Tenant namespace is required")
  .max(63, "Tenant namespace must be at most 63 characters")
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, "Tenant namespace is invalid")

type SkillFile = {
  path: string
  content: Buffer
}

export type SkillWrite = {
  name: string
  description: string
  files: SkillFile[]
}

export type SkillSummary = {
  name: string
  fileCount: number
  sizeBytes: number
  modifiedAt: string | null
}

export type SkillPage = {
  skills: SkillSummary[]
  nextPageToken: string
  hasNextPage: boolean
}

let client: NodeJsClient<S3Client> | undefined

function s3Client(): NodeJsClient<S3Client> {
  if (client) {
    return client
  }

  const env = getEnv()
  client = new S3Client({
    endpoint: env.SKILLS_S3_ENDPOINT,
    forcePathStyle: true,
    region: env.SKILLS_S3_REGION,
    credentials: {
      accessKeyId: env.SKILLS_S3_ACCESS_KEY_ID,
      secretAccessKey: env.SKILLS_S3_SECRET_ACCESS_KEY,
    },
  }) as NodeJsClient<S3Client>
  return client
}

function bucket(): string {
  return getEnv().SKILLS_S3_BUCKET
}

export function skillsRootKey(homeStoragePrefix: string): string {
  const prefix = homeStoragePrefixSchema.parse(homeStoragePrefix)
  return `${prefix}/home/.agents/skills/`
}

export function skillRootKey(homeStoragePrefix: string, skillName: string): string {
  return `${skillsRootKey(homeStoragePrefix)}${skillNameSchema.parse(skillName)}/`
}

export function immutableSkillRootKey(tenantNamespace: string, skillName: string): string {
  return `${tenantNamespaceSchema.parse(tenantNamespace)}/immutable-skills/${skillNameSchema.parse(skillName)}/`
}

export function immutableSkillVersionRootKey(
  tenantNamespace: string,
  skillName: string,
  version: number
): string {
  return `${immutableSkillRootKey(tenantNamespace, skillName)}v${skillVersionSchema.parse(version)}/`
}

export function immutableSkillStoragePath(
  tenantNamespace: string,
  skillName: string,
  version: number
): string {
  return `s3://${bucket()}/${immutableSkillVersionRootKey(tenantNamespace, skillName, version)}`
}

export async function listSkillNames(homeStoragePrefix: string): Promise<string[]> {
  const prefix = skillsRootKey(homeStoragePrefix)
  const names = new Set<string>()
  let token: string | undefined

  do {
    const output = await s3Client().send(
      new ListObjectsV2Command({
        Bucket: bucket(),
        Delimiter: "/",
        Prefix: prefix,
        ContinuationToken: token,
      })
    )
    for (const item of output.CommonPrefixes ?? []) {
      if (!item.Prefix?.startsWith(prefix)) {
        continue
      }
      const rest = item.Prefix.slice(prefix.length)
      const slash = rest.indexOf("/")
      if (slash > 0) {
        const name = skillNameSchema.safeParse(rest.slice(0, slash))
        if (name.success) {
          names.add(name.data)
        }
      }
    }
    token = output.NextContinuationToken
  } while (token)

  return [...names].sort((a, b) => a.localeCompare(b))
}

export async function listSkillPage(
  homeStoragePrefix: string,
  options: { limit?: number; pageToken?: string }
): Promise<SkillPage> {
  const parsed = z
    .object({
      limit: z.number().int().min(1).max(maxListLimit).optional(),
      pageToken: z.string().min(1).optional(),
    })
    .parse(options)
  const limit = parsed.limit ?? defaultListLimit
  const prefix = skillsRootKey(homeStoragePrefix)
  const output = await s3Client().send(
    new ListObjectsV2Command({
      Bucket: bucket(),
      Delimiter: "/",
      MaxKeys: limit,
      Prefix: prefix,
      ContinuationToken: parsed.pageToken,
    })
  )
  const names = (output.CommonPrefixes ?? []).flatMap((item) => {
    if (!item.Prefix?.startsWith(prefix)) {
      return []
    }
    const rest = item.Prefix.slice(prefix.length)
    const slash = rest.indexOf("/")
    if (slash <= 0) {
      return []
    }
    const name = skillNameSchema.safeParse(rest.slice(0, slash))
    return name.success ? [name.data] : []
  })

  return {
    skills: await Promise.all(names.map((name) => mutableSkillSummary(homeStoragePrefix, name))),
    nextPageToken: output.NextContinuationToken ?? "",
    hasNextPage: Boolean(output.IsTruncated),
  }
}

export async function listImmutableSkillVersions(
  tenantNamespace: string,
  skillName: string
): Promise<number[]> {
  const prefix = immutableSkillRootKey(tenantNamespace, skillName)
  const versions = new Set<number>()
  let token: string | undefined

  do {
    const output = await s3Client().send(
      new ListObjectsV2Command({
        Bucket: bucket(),
        Delimiter: "/",
        Prefix: prefix,
        ContinuationToken: token,
      })
    )
    for (const item of output.CommonPrefixes ?? []) {
      if (!item.Prefix?.startsWith(prefix)) {
        continue
      }
      const version = /^v(\d+)\/$/.exec(item.Prefix.slice(prefix.length))?.[1]
      if (version) {
        const value = Number(version)
        if (Number.isSafeInteger(value)) {
          versions.add(value)
        }
      }
    }
    token = output.NextContinuationToken
  } while (token)

  return [...versions].sort((a, b) => a - b)
}

export async function writeImmutableSkillVersion(
  tenantNamespace: string,
  skill: SkillWrite,
  version: number
): Promise<void> {
  const prefix = immutableSkillVersionRootKey(tenantNamespace, skill.name, version)
  const files = skill.files.toSorted((left, right) => {
    if (left.path === "SKILL.md") return -1
    if (right.path === "SKILL.md") return 1
    return left.path.localeCompare(right.path)
  })
  const uploaded: string[] = []
  try {
    for (const file of files) {
      const key = `${prefix}${file.path}`
      await s3Client().send(
        new PutObjectCommand({
          Body: file.content,
          Bucket: bucket(),
          IfNoneMatch: "*",
          Key: key,
        })
      )
      uploaded.push(key)
    }
  } catch (error) {
    try {
      await deleteKeys(uploaded)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "immutable skill upload and cleanup failed")
    }
    throw error
  }
}

export async function deleteImmutableSkillVersion(
  tenantNamespace: string,
  skillName: string,
  version: number
): Promise<void> {
  await deletePrefix(immutableSkillVersionRootKey(tenantNamespace, skillName, version))
}

export async function immutableSkillSummary(
  tenantNamespace: string,
  skillName: string,
  version: number
): Promise<SkillSummary> {
  return skillSummaryFromRoot(
    immutableSkillVersionRootKey(tenantNamespace, skillName, version),
    skillNameSchema.parse(skillName)
  )
}

export async function deleteSkills(homeStoragePrefix: string, skillNames: string[]): Promise<void> {
  for (const name of skillNamesSchema.parse(skillNames)) {
    await deletePrefix(skillRootKey(homeStoragePrefix, name))
  }
}

export async function deleteSkillDirectories(
  homeStoragePrefix: string,
  skillNames: string[]
): Promise<void> {
  for (const name of skillNames) {
    await deletePrefix(skillDirectoryRootKey(homeStoragePrefix, name))
  }
}

export async function writeSkill(homeStoragePrefix: string, skill: SkillWrite): Promise<void> {
  const prefix = skillRootKey(homeStoragePrefix, skill.name)
  for (const file of skill.files) {
    await s3Client().send(
      new PutObjectCommand({
        Body: file.content,
        Bucket: bucket(),
        Key: `${prefix}${file.path}`,
      })
    )
  }
}

export async function replaceSkills(
  homeStoragePrefix: string,
  skills: SkillWrite[],
  overwriteNames = new Set<string>()
): Promise<void> {
  const created: string[] = []
  const existingKeys = new Map<string, string[]>()

  try {
    for (const skill of skills) {
      const keys = await listKeys(skillRootKey(homeStoragePrefix, skill.name))
      if (keys.length > 0) {
        if (!overwriteNames.has(skill.name)) {
          throw new Error("skill already exists")
        }
        existingKeys.set(skill.name, keys)
      } else {
        created.push(skill.name)
      }
    }
    for (const skill of skills) {
      const prefix = skillRootKey(homeStoragePrefix, skill.name)
      await writeSkill(homeStoragePrefix, skill)
      const nextKeys = new Set(skill.files.map((file) => `${prefix}${file.path}`))
      await deleteKeys((existingKeys.get(skill.name) ?? []).filter((key) => !nextKeys.has(key)))
    }
  } catch (error) {
    await deleteSkills(homeStoragePrefix, created)
    throw error
  }
}

export async function streamSkillsZip(
  homeStoragePrefix: string,
  skillNames: string[]
): Promise<ReadableStream> {
  const zip = new ZipFile()
  for (const name of skillNamesSchema.parse(skillNames)) {
    const root = skillDirectoryRootKey(homeStoragePrefix, name)
    for (const key of await listKeys(root)) {
      const path = key.slice(root.length)
      if (!path || path.endsWith("/")) {
        continue
      }
      zip.addReadStreamLazy(`${name}/${path}`, (done) => {
        s3Client()
          .send(new GetObjectCommand({ Bucket: bucket(), Key: key }))
          .then((object) => {
            if (!object.Body) {
              done(new Error("object body is empty"), Readable.from([]))
              return
            }
            done(null, object.Body)
          })
          .catch((error: unknown) => {
            done(error, Readable.from([]))
          })
      })
    }
  }
  zip.end()
  return zipOutput(zip)
}

export async function streamImmutableSkillsZip(
  tenantNamespace: string,
  skills: Array<{ name: string; version: number }>
): Promise<ReadableStream> {
  const zip = new ZipFile()
  for (const skill of skills) {
    const name = skillNameSchema.parse(skill.name)
    const prefix = immutableSkillVersionRootKey(tenantNamespace, name, skill.version)
    for (const key of await listKeys(prefix)) {
      const path = key.slice(prefix.length)
      if (!path || path.endsWith("/")) {
        continue
      }
      zip.addReadStreamLazy(`${name}/${path}`, (done) => {
        s3Client()
          .send(new GetObjectCommand({ Bucket: bucket(), Key: key }))
          .then((object) => {
            if (!object.Body) {
              done(new Error("object body is empty"), Readable.from([]))
              return
            }
            done(null, object.Body)
          })
          .catch((error: unknown) => {
            done(error, Readable.from([]))
          })
      })
    }
  }
  zip.end()
  return zipOutput(zip)
}

function zipOutput(zip: ZipFile): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      zip.outputStream.on("data", (chunk: Uint8Array) => controller.enqueue(chunk))
      zip.outputStream.on("end", () => controller.close())
      zip.outputStream.on("error", (error: Error) => controller.error(error))
    },
  })
}

function skillDirectoryRootKey(homeStoragePrefix: string, skillName: string): string {
  return `${skillsRootKey(homeStoragePrefix)}${skillNameSchema.parse(skillName)}/`
}

async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = []
  let token: string | undefined

  do {
    const output = await s3Client().send(
      new ListObjectsV2Command({
        Bucket: bucket(),
        Prefix: prefix,
        ContinuationToken: token,
      })
    )
    for (const item of output.Contents ?? []) {
      if (item.Key) {
        keys.push(item.Key)
      }
    }
    token = output.NextContinuationToken
  } while (token)

  return keys
}

async function mutableSkillSummary(
  homeStoragePrefix: string,
  skillName: string
): Promise<SkillSummary> {
  const prefix = `${skillsRootKey(homeStoragePrefix)}${skillName}/`
  return skillSummaryFromRoot(prefix, skillName)
}

async function skillSummaryFromRoot(prefix: string, skillName: string): Promise<SkillSummary> {
  let fileCount = 0
  let sizeBytes = 0
  let modifiedAt: Date | undefined
  let token: string | undefined

  do {
    const output = await s3Client().send(
      new ListObjectsV2Command({
        Bucket: bucket(),
        Prefix: prefix,
        ContinuationToken: token,
      })
    )
    for (const item of output.Contents ?? []) {
      if (!item.Key || item.Key.endsWith("/")) {
        continue
      }
      fileCount += 1
      sizeBytes += item.Size ?? 0
      if (item.LastModified && (!modifiedAt || item.LastModified > modifiedAt)) {
        modifiedAt = item.LastModified
      }
    }
    token = output.NextContinuationToken
  } while (token)

  return {
    name: skillName,
    fileCount,
    sizeBytes,
    modifiedAt: modifiedAt?.toISOString() ?? null,
  }
}

async function deletePrefix(prefix: string): Promise<void> {
  await deleteKeys(await listKeys(prefix))
}

async function deleteKeys(keys: string[]): Promise<void> {
  for (let start = 0; start < keys.length; start += deleteBatchSize) {
    const batch = keys.slice(start, start + deleteBatchSize)
    const output = await s3Client().send(
      new DeleteObjectsCommand({
        Bucket: bucket(),
        Delete: {
          Objects: batch.map((Key) => ({ Key })),
          Quiet: true,
        },
      })
    )
    if (output.Errors && output.Errors.length > 0) {
      throw new Error(`failed to delete ${output.Errors.length} skill objects`)
    }
  }
}
