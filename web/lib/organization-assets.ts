import "server-only"

import { createHash, randomUUID } from "node:crypto"
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import sharp from "sharp"
import { getEnv } from "@/lib/env"

const maximumUploadBytes = 2 * 1024 * 1024
const uploadSize = 1024
const publishedSize = 512
const profilePrefix = "organization-profiles/"
const stagingPrefix = "organization-profile-staging/"

type OrganizationAssetsErrorCode = "invalid-upload" | "missing-upload" | "public-access-unavailable"

/** OrganizationAssetsError identifies safe failures that the profile form can explain. */
export class OrganizationAssetsError extends Error {
  constructor(readonly code: OrganizationAssetsErrorCode) {
    super(code)
    this.name = "OrganizationAssetsError"
  }
}

let client: S3Client | undefined

function organizationAssets() {
  const env = getEnv()
  const publicBaseURL = new URL(env.ORGANIZATION_ASSETS_PUBLIC_BASE_URL)
  publicBaseURL.pathname = `${publicBaseURL.pathname.replace(/\/+$/, "")}/`

  client ??= new S3Client({
    region: env.ORGANIZATION_ASSETS_S3_REGION,
    forcePathStyle: env.ORGANIZATION_ASSETS_S3_FORCE_PATH_STYLE,
    ...(env.ORGANIZATION_ASSETS_S3_ENDPOINT
      ? { endpoint: env.ORGANIZATION_ASSETS_S3_ENDPOINT }
      : {}),
    ...(env.ORGANIZATION_ASSETS_S3_ACCESS_KEY_ID && env.ORGANIZATION_ASSETS_S3_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: env.ORGANIZATION_ASSETS_S3_ACCESS_KEY_ID,
            secretAccessKey: env.ORGANIZATION_ASSETS_S3_SECRET_ACCESS_KEY,
            ...(env.ORGANIZATION_ASSETS_S3_SESSION_TOKEN
              ? { sessionToken: env.ORGANIZATION_ASSETS_S3_SESSION_TOKEN }
              : {}),
          },
        }
      : {}),
  })

  return { bucket: env.ORGANIZATION_ASSETS_S3_BUCKET, client, publicBaseURL }
}

/** createOrganizationLogoUpload signs one bounded upload to the caller's staging key. */
export async function createOrganizationLogoUpload(
  organizationId: string,
  userId: string,
  byteLength: number,
  sha256: string
): Promise<{ headers: Record<string, string>; uploadUrl: string }> {
  if (byteLength < 1 || byteLength > maximumUploadBytes) {
    throw new OrganizationAssetsError("invalid-upload")
  }

  const { bucket, client: s3 } = organizationAssets()
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: bucket,
      Key: `${stagingPrefix}${organizationId}/${userId}/profile.webp`,
      ContentLength: byteLength,
      ContentType: "image/webp",
      Metadata: { sha256 },
    }),
    {
      expiresIn: 120,
      signableHeaders: new Set(["content-length", "content-type"]),
      unhoistableHeaders: new Set(["x-amz-meta-sha256"]),
    }
  )

  return {
    headers: {
      "content-type": "image/webp",
      "x-amz-meta-sha256": sha256,
    },
    uploadUrl,
  }
}

/** publishOrganizationLogo verifies, re-encodes, and publishes a staged profile image. */
export async function publishOrganizationLogo(
  organizationId: string,
  userId: string,
  sha256: string
): Promise<string> {
  const { bucket, client: s3, publicBaseURL } = organizationAssets()
  const stagingKey = `${stagingPrefix}${organizationId}/${userId}/profile.webp`
  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: stagingKey }))
  if (
    head.ContentLength === undefined ||
    head.ContentLength < 1 ||
    head.ContentLength > maximumUploadBytes ||
    head.ContentType !== "image/webp" ||
    head.Metadata?.sha256 !== sha256
  ) {
    throw new OrganizationAssetsError("invalid-upload")
  }

  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: stagingKey }))
  if (!object.Body) {
    throw new OrganizationAssetsError("missing-upload")
  }
  const input = Buffer.from(await object.Body.transformToByteArray())
  if (input.byteLength !== head.ContentLength) {
    throw new OrganizationAssetsError("invalid-upload")
  }
  if (createHash("sha256").update(input).digest("hex") !== sha256) {
    throw new OrganizationAssetsError("invalid-upload")
  }

  const options = { failOn: "warning" as const, limitInputPixels: uploadSize * uploadSize }
  const metadata = await sharp(input, options).metadata()
  if (
    metadata.format !== "webp" ||
    metadata.width !== uploadSize ||
    metadata.height !== uploadSize
  ) {
    throw new OrganizationAssetsError("invalid-upload")
  }
  const output = await sharp(input, options)
    .resize(publishedSize, publishedSize, { fit: "fill" })
    .webp({ effort: 4, quality: 85 })
    .toBuffer()

  const publishedKey = `${profilePrefix}${organizationId}/${randomUUID()}.webp`
  await s3.send(
    new PutObjectCommand({
      ACL: "public-read",
      Bucket: bucket,
      Key: publishedKey,
      Body: output,
      CacheControl: "public, max-age=31536000, immutable",
      ContentDisposition: "inline",
      ContentLength: output.byteLength,
      ContentType: "image/webp",
    })
  )

  const publicURL = new URL(publishedKey, publicBaseURL).toString()
  try {
    const response = await fetch(publicURL, {
      cache: "no-store",
      method: "HEAD",
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) {
      throw new OrganizationAssetsError("public-access-unavailable")
    }
  } catch (error) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: publishedKey }))
    if (error instanceof OrganizationAssetsError) {
      throw error
    }
    throw new OrganizationAssetsError("public-access-unavailable")
  }

  return publicURL
}

/** deleteOrganizationLogo deletes a URL only when it belongs to the managed profile prefix. */
export async function deleteOrganizationLogo(url: string | null): Promise<void> {
  if (!url) {
    return
  }

  const { bucket, client: s3, publicBaseURL } = organizationAssets()
  const candidate = new URL(url)
  if (
    candidate.origin !== publicBaseURL.origin ||
    candidate.search ||
    candidate.hash ||
    !candidate.pathname.startsWith(publicBaseURL.pathname)
  ) {
    return
  }

  const key = candidate.pathname.slice(publicBaseURL.pathname.length)
  if (!key.startsWith(profilePrefix)) {
    return
  }
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
}

/** deleteOrganizationLogoUpload removes the caller's single staging object. */
export async function deleteOrganizationLogoUpload(
  organizationId: string,
  userId: string
): Promise<void> {
  const { bucket, client: s3 } = organizationAssets()
  await s3.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: `${stagingPrefix}${organizationId}/${userId}/profile.webp`,
    })
  )
}
