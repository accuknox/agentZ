import type { OAuth2Tokens } from "@better-auth/core/oauth2"
import { Octokit } from "@octokit/rest"
import * as z from "zod"
import { getEnv } from "@/lib/env"

type GithubProfile = Awaited<ReturnType<Octokit["rest"]["users"]["getAuthenticated"]>>["data"]
type GithubEmail = Awaited<
  ReturnType<Octokit["rest"]["users"]["listEmailsForAuthenticatedUser"]>
>["data"][number]

const githubMembershipErrorSchema = z
  .object({
    name: z.string().optional(),
    message: z.string().optional(),
    status: z.number().optional(),
    request: z
      .object({
        method: z.string().optional(),
        url: z.string().optional(),
      })
      .optional(),
    response: z
      .object({
        url: z.string().optional(),
      })
      .optional(),
  })
  .catch({})

function githubErrorDetails(err: unknown) {
  const e = githubMembershipErrorSchema.parse(err)
  return {
    error:
      err instanceof Error
        ? {
            message: err.message,
            name: err.name,
          }
        : {
            message: e.message ?? "unknown error",
            name: e.name ?? "unknown",
          },
    method: e.request?.method,
    requestUrl: e.request?.url,
    responseUrl: e.response?.url,
    status: e.status,
  }
}

function githubErrorStatus(err: unknown) {
  return githubMembershipErrorSchema.parse(err).status
}

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
    .catch((err: unknown) => {
      if (githubErrorStatus(err) === 404) {
        return null
      }
      throw err
    })

  if (!orgMembership || orgMembership.data.state !== "active") {
    console.warn("github org membership rejected", {
      login: profile.login,
      org: env.GITHUB_ORG,
      membership: orgMembership?.data.state ?? null,
    })
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
    .catch((err: unknown) => {
      if (githubErrorStatus(err) === 404) {
        return null
      }
      throw err
    })

  if (!teamMembership || teamMembership.data.state !== "active") {
    console.warn("github team membership rejected", {
      login: profile.login,
      org: env.GITHUB_ORG,
      team: env.GITHUB_TEAM_SLUG,
      membership: teamMembership?.data.state ?? null,
    })
    return false
  }

  return true
}

// getGithubUserInfo reads the authenticated GitHub profile and enforces the
// optional org/team gate before Better Auth creates a session.
export async function getGithubUserInfo(token: OAuth2Tokens) {
  if (!token.accessToken) {
    return null
  }

  const env = getEnv()
  const octokit = new Octokit({ auth: token.accessToken })

  try {
    const { data: profile } = await octokit.rest.users.getAuthenticated()

    if (!(await isGithubUserAllowed(octokit, profile))) {
      return null
    }

    let primary: GithubEmail | undefined

    try {
      const { data: emails } = await octokit.rest.users.listEmailsForAuthenticatedUser()
      primary = emails.find((email) => email.primary) ?? emails[0]
    } catch (err) {
      console.warn("github email lookup failed", {
        login: profile.login,
        org: env.GITHUB_ORG,
        team: env.GITHUB_TEAM_SLUG,
        ...githubErrorDetails(err),
      })
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
  } catch (err) {
    console.error("github auth gate failed", {
      allowedUserId: env.GITHUB_ALLOWED_USER_ID,
      org: env.GITHUB_ORG,
      team: env.GITHUB_TEAM_SLUG,
      ...githubErrorDetails(err),
    })
    return null
  }
}
