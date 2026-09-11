import { NextRequest, NextResponse } from "next/server"
import { finishGitHubConnection } from "@/lib/coding/github"
import { getEnv } from "@/lib/env"

export async function GET(request: NextRequest) {
  const target = new URL("/settings/account", getEnv().BETTER_AUTH_URL)
  const code = request.nextUrl.searchParams.get("code")
  const state = request.nextUrl.searchParams.get("state")
  try {
    if (!code || !state) throw new Error("GitHub authorization was cancelled")
    await finishGitHubConnection(code, state)
    target.searchParams.set("github", "connected")
  } catch {
    // OAuth errors can contain request bodies with tokens. Never log them.
    target.searchParams.set("github", "failed")
  }
  return NextResponse.redirect(target)
}
