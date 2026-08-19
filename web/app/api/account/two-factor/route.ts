import { createOTP } from "@better-auth/utils/otp"
import { and, eq, like } from "drizzle-orm"
import { NextResponse } from "next/server"
import { headers } from "next/headers"
import { generateRandomString, symmetricEncrypt } from "better-auth/crypto"
import * as z from "zod"
import { getDB, schema } from "@/db"
import { getAuth } from "@/lib/auth"
import { getEnv } from "@/lib/env"
import { dayjs } from "@/lib/format"

const freshAge = dayjs.duration(5, "minutes")
const trustDeviceCookieName = "trust_device"

type ManageAction = "enable" | "disable"
type Provider = "credential" | "github" | "google"

type ReauthRequiredResponse = {
  action: ManageAction
  provider: Provider
  status: "reauth_required"
}

type SetupResponse = {
  backupCodes: string[]
  status: "ok"
  totpURI: string
}

type DisableResponse = {
  status: "ok"
}

const manageBodySchema = z.object({
  action: z.enum(["enable", "disable"], { error: "2FA action is invalid" }),
})

/**
 * POST manages account-level two-factor enrollment and removal behind an
 * app-owned fresh-session check so account settings can force re-auth without
 * exposing Better Auth's password-only enable/disable contract in the UI.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const baseURL = new URL(getEnv().BETTER_AUTH_URL).origin
  const origin = request.headers.get("origin")
  const referer = request.headers.get("referer")
  const fetchSite = request.headers.get("sec-fetch-site")
  const contentType = request.headers.get("content-type")

  if (!contentType?.startsWith("application/json")) {
    return NextResponse.json({ message: "Unsupported media type" }, { status: 415 })
  }

  if (
    fetchSite &&
    fetchSite !== "same-origin" &&
    fetchSite !== "same-site" &&
    fetchSite !== "none"
  ) {
    return NextResponse.json({ message: "Forbidden" }, { status: 403 })
  }

  if (!origin && !referer) {
    return NextResponse.json({ message: "Forbidden" }, { status: 403 })
  }

  if (origin && origin !== baseURL) {
    return NextResponse.json({ message: "Forbidden" }, { status: 403 })
  }

  if (referer && new URL(referer).origin !== baseURL) {
    return NextResponse.json({ message: "Forbidden" }, { status: 403 })
  }

  const auth = getAuth()
  const requestHeaders = await headers()
  const session = await auth.api.getSession({
    headers: requestHeaders,
    query: {
      disableCookieCache: true,
    },
  })
  if (!session) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 })
  }

  let body: z.infer<typeof manageBodySchema>
  try {
    const parsed = manageBodySchema.safeParse(await request.json())
    if (!parsed.success) {
      return NextResponse.json({ message: "Invalid action" }, { status: 400 })
    }
    body = parsed.data
  } catch {
    return NextResponse.json({ message: "Invalid request body" }, { status: 400 })
  }

  const accounts = await auth.api.listUserAccounts({
    headers: requestHeaders,
  })
  let provider: Provider = "credential"
  if (!accounts.some((account) => account.providerId === "credential")) {
    const currentProvider = accounts[0]?.providerId
    if (currentProvider === "github" || currentProvider === "google") {
      provider = currentProvider
    }
  }

  if (dayjs().diff(session.session.createdAt) >= freshAge.asMilliseconds()) {
    const response: ReauthRequiredResponse = {
      action: body.action,
      provider,
      status: "reauth_required",
    }
    return NextResponse.json(response, { status: 403 })
  }

  const db = getDB()
  if (body.action === "disable") {
    await db.transaction(async (tx) => {
      await tx
        .update(schema.users)
        .set({ twoFactorEnabled: false })
        .where(eq(schema.users.id, session.user.id))
      await tx.delete(schema.twoFactors).where(eq(schema.twoFactors.userId, session.user.id))
    })

    const response: DisableResponse = { status: "ok" }
    const next = NextResponse.json(response)
    next.cookies.set(trustDeviceCookieName, "", {
      expires: dayjs(0).toDate(),
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: new URL(getEnv().BETTER_AUTH_URL).protocol === "https:",
    })
    await db
      .delete(schema.verifications)
      .where(
        and(
          eq(schema.verifications.value, session.user.id),
          like(schema.verifications.identifier, "trust-device-%")
        )
      )
    return next
  }

  const secret = generateRandomString(32)
  const encryptedSecret = await symmetricEncrypt({
    data: secret,
    key: getEnv().BETTER_AUTH_SECRET,
  })
  const backupCodes = Array.from({ length: 10 }, () =>
    generateRandomString(10, "a-z", "0-9", "A-Z")
  ).map((code) => `${code.slice(0, 5)}-${code.slice(5)}`)
  const encryptedBackupCodes = await symmetricEncrypt({
    data: JSON.stringify(backupCodes),
    key: getEnv().BETTER_AUTH_SECRET,
  })

  await db.transaction(async (tx) => {
    await tx
      .update(schema.users)
      .set({ twoFactorEnabled: false })
      .where(eq(schema.users.id, session.user.id))
    await tx.delete(schema.twoFactors).where(eq(schema.twoFactors.userId, session.user.id))
    await tx.insert(schema.twoFactors).values({
      backupCodes: encryptedBackupCodes,
      id: generateRandomString(32),
      secret: encryptedSecret,
      userId: session.user.id,
      verified: false,
    })
  })

  const response: SetupResponse = {
    backupCodes,
    status: "ok",
    totpURI: createOTP(secret, { digits: 6 }).url("AgentZ", session.user.email),
  }
  return NextResponse.json(response)
}
