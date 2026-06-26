function read(name) {
  const value = process.env[name]
  if (typeof value !== "string") {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

function required(name, min = 1) {
  const value = read(name)
  if (!value || value.length < min) {
    throw new Error(`${name} is required`)
  }

  return value
}

function requiredURL(name) {
  const value = required(name)

  try {
    new URL(value)
  } catch {
    throw new Error(`${name} must be a valid URL`)
  }

  return value
}

function validateRuntimeEnv() {
  required("DATABASE_URL")
  requiredURL("BETTER_AUTH_URL")
  required("BETTER_AUTH_SECRET", 32)
  required("MCP_OAUTH_COOKIE_SECRET", 32)
  requiredURL("GATEWAY_BASE_URL")

  const githubClientID = read("GITHUB_CLIENT_ID")
  const githubClientSecret = read("GITHUB_CLIENT_SECRET")
  const githubAllowedUserID = read("GITHUB_ALLOWED_USER_ID")
  const googleClientID = read("GOOGLE_CLIENT_ID")
  const googleClientSecret = read("GOOGLE_CLIENT_SECRET")
  const githubOrg = read("GITHUB_ORG")
  const githubTeamSlug = read("GITHUB_TEAM_SLUG")

  if (Boolean(githubClientID) !== Boolean(githubClientSecret)) {
    throw new Error("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set together.")
  }

  if (Boolean(googleClientID) !== Boolean(googleClientSecret)) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together.")
  }

  if (githubAllowedUserID && !/^\d+$/.test(githubAllowedUserID)) {
    throw new Error("GITHUB_ALLOWED_USER_ID must contain only digits.")
  }

  if (!githubClientID && !googleClientID) {
    throw new Error("At least one social provider (GITHUB or GOOGLE) must be configured.")
  }

  if (githubTeamSlug && !githubOrg) {
    throw new Error("GITHUB_TEAM_SLUG requires GITHUB_ORG.")
  }
}

// Fail fast on missing runtime secrets before the standalone server accepts
// traffic.
validateRuntimeEnv()

require("./server.js")
