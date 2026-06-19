import type { OAuth2Tokens } from "@better-auth/core/oauth2"
import { Octokit } from "@octokit/rest"
import { env } from "@/lib/env"

type GithubProfile = Awaited<ReturnType<Octokit["rest"]["users"]["getAuthenticated"]>>["data"]

const placeholderEmail = (id: string) => `github-${id}@auth.accuknox.invalid`

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
    .catch((err: { status?: number }) => {
      if (err.status === 404) {
        return null
      }
      throw err
    })

  if (!orgMembership || orgMembership.data.state !== "active") {
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
    .catch((err: { status?: number }) => {
      if (err.status === 404) {
        return null
      }
      throw err
    })

  if (!teamMembership || teamMembership.data.state !== "active") {
    return false
  }

  return true
}

export async function getGithubUserInfo(token: OAuth2Tokens) {
  if (!token.accessToken) {
    return null
  }

  const octokit = new Octokit({ auth: token.accessToken })

  try {
    const [{ data: profile }, { data: emails }] = await Promise.all([
      octokit.rest.users.getAuthenticated(),
      octokit.rest.users.listEmailsForAuthenticatedUser(),
    ])

    if (!(await isGithubUserAllowed(octokit, profile))) {
      return null
    }

    const primary = emails.find((email) => email.primary) ?? emails[0]
    const email = primary?.email ?? placeholderEmail(String(profile.id))
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
    console.error("github auth gate failed", {
      allowedUserId: env.GITHUB_ALLOWED_USER_ID,
      org: env.GITHUB_ORG,
      team: env.GITHUB_TEAM_SLUG,
      err,
    })
    return null
  }
}
