import type { OAuth2Tokens } from "@better-auth/core/oauth2"
import { Octokit } from "@octokit/rest"
import { env } from "@/lib/env"

type GithubProfile = Awaited<ReturnType<Octokit["rest"]["users"]["getAuthenticated"]>>["data"]
type GithubEmail = Awaited<
  ReturnType<Octokit["rest"]["users"]["listEmailsForAuthenticatedUser"]>
>["data"][number]
type GithubMembershipError = {
  status?: number
  request?: {
    method?: string
    url?: string
  }
  response?: {
    url?: string
    headers?: Record<string, string>
    data?: unknown
  }
}

async function isGithubUserAllowed(octokit: Octokit, profile: GithubProfile) {
  if (env.GITHUB_ALLOWED_USER_ID) {
    return String(profile.id) === env.GITHUB_ALLOWED_USER_ID
  }

  if (!env.GITHUB_ORG) {
    return true
  }

  const orgMembership = await octokit.rest.orgs
    .getMembershipForAuthenticatedUser({
      org: env.GITHUB_ORG,
    })
    .catch((err: GithubMembershipError) => {
      if (err.status === 404) {
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
    .catch((err: GithubMembershipError) => {
      if (err.status === 404) {
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
        err,
      })
    }

    const email = profile.email ?? primary?.email ?? `github-${profile.id}@auth.accuknox.invalid`
    const emailVerified = primary?.email ? primary.verified : false

    return {
      user: {
        id: String(profile.id),
        name: profile.name || profile.login,
        email,
        emailVerified,
        image: profile.avatar_url,
      },
      data: profile satisfies GithubProfile,
    }
  } catch (err) {
    const e = err as GithubMembershipError

    console.error("github auth gate failed", {
      allowedUserId: env.GITHUB_ALLOWED_USER_ID,
      org: env.GITHUB_ORG,
      team: env.GITHUB_TEAM_SLUG,
      err:
        err instanceof Error
          ? {
              name: err.name,
              message: err.message,
              stack: err.stack,
            }
          : err,
      status: e.status,
      method: e.request?.method,
      requestUrl: e.request?.url,
      responseUrl: e.response?.url,
      responseHeaders: e.response?.headers,
      responseData: e.response?.data,
    })
    return null
  }
}
