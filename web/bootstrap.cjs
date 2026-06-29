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
  const enableEmailPasswordAuth = read("ENABLE_EMAIL_PASSWORD_AUTH")
  const emailPasswordAllowedUsers = read("EMAIL_PASSWORD_AUTH_ALLOWED_USER")
  const emailPasswordEnabled =
    enableEmailPasswordAuth === "1" ||
    enableEmailPasswordAuth === "true" ||
    enableEmailPasswordAuth === "TRUE"

  if (Boolean(githubClientID) !== Boolean(githubClientSecret)) {
    throw new Error("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set together.")
  }

  if (Boolean(googleClientID) !== Boolean(googleClientSecret)) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together.")
  }

  if (githubAllowedUserID && !/^\d+$/.test(githubAllowedUserID)) {
    throw new Error("GITHUB_ALLOWED_USER_ID must contain only digits.")
  }

  if (!githubClientID && !googleClientID && !emailPasswordEnabled) {
    throw new Error("At least one auth method must be configured.")
  }

  if (emailPasswordAllowedUsers) {
    for (const email of emailPasswordAllowedUsers.split(",")) {
      const value = email.trim().toLowerCase()
      if (!value) {
        continue
      }

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        throw new Error("EMAIL_PASSWORD_AUTH_ALLOWED_USER must contain valid email addresses.")
      }
    }
  }

  if (githubTeamSlug && !githubOrg) {
    throw new Error("GITHUB_TEAM_SLUG requires GITHUB_ORG.")
  }
}

// Fail fast on missing runtime secrets before the standalone server accepts
// traffic.
validateRuntimeEnv()

require("./server.js")
