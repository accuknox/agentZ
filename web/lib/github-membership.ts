import type { OAuth2Tokens } from "@better-auth/core/oauth2"
import { Octokit } from "@octokit/rest"
import { RequestError } from "@octokit/request-error"
import { and, eq } from "drizzle-orm"
import { getOAuthState } from "better-auth/api"
import * as z from "zod"
import { getDB, schema } from "@/db"
import { getEnv } from "@/lib/env"

type GithubProfile = Awaited<ReturnType<Octokit["rest"]["users"]["getAuthenticated"]>>["data"]
type GithubEmail = Awaited<
  ReturnType<Octokit["rest"]["users"]["listEmailsForAuthenticatedUser"]>
>["data"][number]

export const socialOAuthStateSchema = z.object({
  agentzEnrollment: z.literal("social"),
  organizationId: z.string().min(1),
  provider: z.enum(["github", "google"]),
})

async function isGithubUserAllowed(octokit: Octokit, profile: GithubProfile) {
  const env = getEnv()

  if (env.GITHUB_ALLOWED_USER_ID) {
    return profile.id.toString() === env.GITHUB_ALLOWED_USER_ID
  }

  if (!env.GITHUB_ORG) {
    return true
  }

  const orgMembership = await octokit.rest.orgs
    .getMembershipForAuthenticatedUser({
      org: env.GITHUB_ORG,
    })
    .catch((error: RequestError) => {
      if (error.status === 404) {
        return null
      }
      throw error
    })

  if (!orgMembership || orgMembership.data.state !== "active") {
    console.warn("github sign-in rejected: organisation membership not active")
    return false
  }

  if (!env.GITHUB_TEAM_SLUG) {
    return true
  }

  const teamMembership = await octokit.rest.teams
    .getMembershipForUserInOrg({
      org: env.GITHUB_ORG,
      team_slug: env.GITHUB_TEAM_SLUG,
      username: profile.login,
    })
    .catch((error: RequestError) => {
      if (error.status === 404) {
        return null
      }
      throw error
    })

  if (!teamMembership || teamMembership.data.state !== "active") {
    console.warn("github sign-in rejected: team membership not active")
    return false
  }

  return true
}

async function matchesSocialAdmissionRule(octokit: Octokit, profile: GithubProfile) {
  const state = socialOAuthStateSchema.safeParse(await getOAuthState())
  if (!state.success || state.data.provider !== "github") {
    return undefined
  }

  const rules = await getDB()
    .select({
      organization: schema.socialAdmissionGithubRules.githubOrganization,
      team: schema.socialAdmissionGithubRules.githubTeam,
    })
    .from(schema.socialAdmissionGithubRules)
    .innerJoin(
      schema.socialAdmissionPolicies,
      and(
        eq(
          schema.socialAdmissionPolicies.organizationId,
          schema.socialAdmissionGithubRules.organizationId
        ),
        eq(schema.socialAdmissionPolicies.enabled, true)
      )
    )
    .where(eq(schema.socialAdmissionGithubRules.organizationId, state.data.organizationId))
  for (const rule of rules) {
    const organization = await octokit.rest.orgs
      .getMembershipForAuthenticatedUser({ org: rule.organization })
      .catch((error: RequestError) => {
        if (error.status === 404) {
          return null
        }
        throw error
      })
    if (organization?.data.state !== "active") {
      continue
    }
    if (!rule.team) {
      return true
    }

    const team = await octokit.rest.teams
      .getMembershipForUserInOrg({
        org: rule.organization,
        team_slug: rule.team,
        username: profile.login,
      })
      .catch((error: RequestError) => {
        if (error.status === 404) {
          return null
        }
        throw error
      })
    if (team?.data.state === "active") {
      return true
    }
  }
  return false
}

// getGithubUserInfo reads the authenticated GitHub profile and enforces the
// optional org/team gate before Better Auth creates a session.
export async function getGithubUserInfo(token: OAuth2Tokens) {
  if (!token.accessToken) {
    return null
  }

  const octokit = new Octokit({ auth: token.accessToken })

  try {
    const { data: profile } = await octokit.rest.users.getAuthenticated()

    const socialAdmission = await matchesSocialAdmissionRule(octokit, profile)
    if (socialAdmission === false) {
      return null
    }
    if (socialAdmission === undefined && !(await isGithubUserAllowed(octokit, profile))) {
      return null
    }

    let primary: GithubEmail | undefined

    try {
      const { data: emails } = await octokit.rest.users.listEmailsForAuthenticatedUser()
      primary = emails.find((email) => email.primary) ?? emails[0]
    } catch {
      console.warn("github sign-in rejected: email lookup failed")
    }
    if (socialAdmission !== undefined && !primary?.verified) {
      return null
    }

    const email = profile.email ?? primary?.email ?? `github-${profile.id}@auth.accuknox.invalid`
    const emailVerified = primary?.email ? primary.verified : false

    return {
      user: {
        id: profile.id.toString(),
        name: profile.name || profile.login,
        email,
        emailVerified,
        image: profile.avatar_url,
      },
      data: profile satisfies GithubProfile,
    }
  } catch {
    console.error("github sign-in rejected: provider gate failed")
    return null
  }
}
