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
import { getEnv } from "@/lib/env"

const deleteBatchSize = 1000
const defaultListLimit = 50
const maxListLimit = 200

export const skillNameSchema = z
  .string({ error: "Skill name is required" })
  .trim()
  .min(1, "Skill name is required")
  .max(64, "Skill name must be at most 64 characters")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Skill name is invalid")

export const skillNamesSchema = z
  .array(skillNameSchema, { error: "Skills must be a list" })
  .min(1, "Select at least one skill")
  .max(200, "Select at most 200 skills")

const homeStoragePrefixSchema = z
  .string({ error: "Agent home is not ready" })
  .trim()
  .min(1, "Agent home is not ready")
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Agent home storage prefix is invalid")

type SkillFile = {
  path: string
  content: Buffer
}

export type SkillWrite = {
  name: string
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
    forcePathStyle: false,
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
        names.add(rest.slice(0, slash))
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
  const limit = Math.min(Math.max(options.limit ?? defaultListLimit, 1), maxListLimit)
  const prefix = skillsRootKey(homeStoragePrefix)
  const output = await s3Client().send(
    new ListObjectsV2Command({
      Bucket: bucket(),
      Delimiter: "/",
      MaxKeys: limit,
      Prefix: prefix,
      ContinuationToken: options.pageToken,
    })
  )
  const names = (output.CommonPrefixes ?? [])
    .map((item) => {
      if (!item.Prefix?.startsWith(prefix)) {
        return
      }
      const rest = item.Prefix.slice(prefix.length)
      const slash = rest.indexOf("/")
      if (slash <= 0) {
        return
      }
      return rest.slice(0, slash)
    })
    .filter((name) => name !== undefined)

  return {
    skills: await Promise.all(names.map((name) => skillSummary(homeStoragePrefix, name))),
    nextPageToken: output.NextContinuationToken ?? "",
    hasNextPage: Boolean(output.IsTruncated),
  }
}

export async function deleteSkills(homeStoragePrefix: string, skillNames: string[]): Promise<void> {
  for (const name of skillNamesSchema.parse(skillNames)) {
    await deletePrefix(skillRootKey(homeStoragePrefix, name))
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
    const root = skillRootKey(homeStoragePrefix, name)
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
  if (!(zip.outputStream instanceof Readable)) {
    throw new Error("zip stream is unavailable")
  }
  return zipOutputBody(zip.outputStream)
}

function zipOutputBody(stream: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on("data", (chunk: Buffer | string) => {
        controller.enqueue(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
      })
      stream.once("end", () => controller.close())
      stream.once("error", (error: Error) => controller.error(error))
    },
    cancel() {
      stream.destroy()
    },
  })
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

async function skillSummary(homeStoragePrefix: string, skillName: string): Promise<SkillSummary> {
  const prefix = `${skillsRootKey(homeStoragePrefix)}${skillName}/`
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
    await s3Client().send(
      new DeleteObjectsCommand({
        Bucket: bucket(),
        Delete: {
          Objects: batch.map((Key) => ({ Key })),
          Quiet: true,
        },
      })
    )
  }
}
