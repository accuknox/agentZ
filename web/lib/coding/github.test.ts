import { mock, test } from "node:test"
import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { eq, inArray } from "drizzle-orm"
import { z } from "zod"
import { getDB, schema } from "@/db"

// Run against an explicit test database with the Coding migrations applied.
test(
  "GitHub credentials stay bound to the acting user across callbacks and rotation",
  { skip: !process.env.CODING_TEST_DATABASE_URL },
  async () => {
    assert.ok(process.env.CODING_TEST_DATABASE_URL)
    process.env.DATABASE_URL = process.env.CODING_TEST_DATABASE_URL
    process.env.CODING_GITHUB_ENCRYPTION_KEY = randomBytes(32).toString("hex")
    process.env.CODING_GITHUB_CLIENT_ID = "Iv-test-app"
    process.env.CODING_GITHUB_CLIENT_SECRET = "test-only-app-secret"
    const owner = { user: { id: randomUUID() }, session: { id: randomUUID() } }
    const other = { user: { id: randomUUID() }, session: { id: randomUUID() } }
    let actor: typeof owner | null = owner
    const headersMock = mock.module("next/headers", {
      namedExports: { headers: async () => new Headers() },
    })
    const authMock = mock.module("@/lib/auth", {
      namedExports: {
        getAuth: () => ({
          api: {
            getSession: async ({ query }: { query: { disableCookieCache: boolean } }) => {
              assert.equal(query.disableCookieCache, true)
              return actor
            },
          },
        }),
      },
    })
    const realFetch = globalThis.fetch
    let requests = 0
    let refreshes = 0
    let failUserLookup = false
    let returnedUser = 1001
    let failRevocation = false
    globalThis.fetch = async (input, init) => {
      requests++
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.href === "https://github.com/login/oauth/access_token") {
        const body = z
          .object({
            grant_type: z.string().optional(),
            code_verifier: z.string().optional(),
            refresh_token: z.string().optional(),
          })
          .parse(await request.json())
        if (body.grant_type === "refresh_token") {
          refreshes++
          assert.ok(body.refresh_token?.startsWith("ghr_"))
        } else {
          assert.ok(body.code_verifier)
        }
        return Response.json(
          {
            access_token: `ghu_test_${refreshes}`,
            refresh_token: `ghr_test_${refreshes}`,
            expires_in: 28800,
            refresh_token_expires_in: 15897600,
            token_type: "bearer",
            scope: "",
          },
          { headers: { date: new Date().toUTCString() } }
        )
      }
      assert.equal(url.hostname, "api.github.com")
      if (url.pathname === "/user") {
        if (failUserLookup) return Response.json({ message: "Unavailable" }, { status: 503 })
        assert.match(request.headers.get("authorization") ?? "", /^token ghu_test_/)
        return Response.json({
          id: returnedUser,
          login: `user-${returnedUser}`,
          name: "Verified user",
        })
      }
      if (url.pathname.endsWith("/grant") && request.method === "DELETE") {
        if (failRevocation) return Response.json({ message: "Unavailable" }, { status: 503 })
        return new Response(null, { status: 204 })
      }
      throw new Error(`Unexpected GitHub test request ${request.method} ${url.pathname}`)
    }
    const github = await import("./github")
    const db = getDB()
    try {
      for (const fixture of [owner, other]) {
        await db.insert(schema.users).values({
          id: fixture.user.id,
          name: "GitHub security fixture",
          email: `${fixture.user.id}@example.com`,
        })
        await db.insert(schema.sessions).values({
          id: fixture.session.id,
          userId: fixture.user.id,
          token: randomUUID(),
          expiresAt: new Date(Date.now() + 3600000),
          updatedAt: new Date(),
        })
      }
      const url = new URL(await github.beginGitHubConnection())
      const state = url.searchParams.get("state")
      assert.ok(state)
      assert.equal(url.searchParams.get("code_challenge_method"), "S256")
      const before = requests
      actor = other
      await assert.rejects(github.finishGitHubConnection("test-code", state))
      assert.equal(requests, before, "cross-user callback reached GitHub")
      actor = { ...owner, session: { id: randomUUID() } }
      await assert.rejects(github.finishGitHubConnection("test-code", state))
      assert.equal(requests, before, "cross-session callback reached GitHub")
      actor = owner
      await github.finishGitHubConnection("test-code", state)
      const after = requests
      await assert.rejects(github.finishGitHubConnection("test-code", state))
      assert.equal(requests, after, "replayed callback reached GitHub")
      const [connection] = await db
        .select()
        .from(schema.githubConnections)
        .where(eq(schema.githubConnections.userId, owner.user.id))
      assert.ok(connection)
      assert.ok(!connection.accessToken.includes("ghu_test"))
      assert.ok(!connection.refreshToken.includes("ghr_test"))
      const identity = await github.withGitHub(async ({ email }) => email)
      assert.equal(identity, "1001+user-1001@users.noreply.github.com")
      actor = other
      await assert.rejects(
        github.withGitHub(async () => true),
        /Connect your GitHub account/
      )
      await db.insert(schema.githubConnections).values({ ...connection, userId: other.user.id })
      const beforeSwap = requests
      await assert.rejects(github.withGitHub(async () => true))
      assert.equal(requests, beforeSwap, "copied ciphertext reached GitHub")
      actor = owner
      returnedUser = 2002
      await assert.rejects(
        github.withGitHub(async () => true),
        /identity changed/
      )
      returnedUser = 1001
      await db
        .update(schema.githubConnections)
        .set({ expiresAt: new Date(0) })
        .where(eq(schema.githubConnections.userId, owner.user.id))
      failUserLookup = true
      await assert.rejects(github.withGitHub(async () => true))
      assert.equal(refreshes, 1)
      const [rotated] = await db
        .select()
        .from(schema.githubConnections)
        .where(eq(schema.githubConnections.userId, owner.user.id))
      assert.ok(rotated)
      assert.notEqual(
        rotated.refreshToken,
        connection.refreshToken,
        "failed API call rolled back refresh"
      )
      failUserLookup = false
      await Promise.all(Array.from({ length: 6 }, () => github.withGitHub(async () => true)))
      assert.equal(refreshes, 1, "concurrent calls rotated an already refreshed token")
      await db
        .update(schema.githubConnections)
        .set({ expiresAt: new Date(0) })
        .where(eq(schema.githubConnections.userId, owner.user.id))
      await Promise.all(Array.from({ length: 6 }, () => github.withGitHub(async () => true)))
      assert.equal(refreshes, 2, "concurrent expiry refreshed more than once")
      failRevocation = true
      await assert.rejects(github.disconnectGitHub())
      assert.equal(
        (
          await db
            .select()
            .from(schema.githubConnections)
            .where(eq(schema.githubConnections.userId, owner.user.id))
        ).length,
        1
      )
      failRevocation = false
      await github.disconnectGitHub()
      assert.equal(
        (
          await db
            .select()
            .from(schema.githubConnections)
            .where(eq(schema.githubConnections.userId, owner.user.id))
        ).length,
        0
      )
      actor = null
      await assert.rejects(github.beginGitHubConnection(), /Sign in/)
    } finally {
      globalThis.fetch = realFetch
      headersMock.restore()
      authMock.restore()
      await db
        .delete(schema.githubConnections)
        .where(inArray(schema.githubConnections.userId, [owner.user.id, other.user.id]))
      await db
        .delete(schema.githubAuthorizations)
        .where(inArray(schema.githubAuthorizations.userId, [owner.user.id, other.user.id]))
      await db.delete(schema.users).where(inArray(schema.users.id, [owner.user.id, other.user.id]))
      await db.$client.end()
    }
  }
)
