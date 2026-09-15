# GitHub and Google sign-in

This guide assumes you have already followed the quickstart guide through
[creating the necessary secrets](./README.md#create-necessary-agentz-secrets).

Replace the example domain and credentials with your own. You can configure
either provider or both.

## GitHub

[Create a GitHub OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)
with these settings, then generate a client secret:

| Field                      | Value                                                 |
|----------------------------|-------------------------------------------------------|
| Application name           | `AgentZ`                                              |
| Homepage URL               | `https://agentz.example.com`                          |
| Authorization callback URL | `https://agentz.example.com/api/auth/callback/github` |

Add the client secret to the existing Secret:

```bash
kubectl patch secret agentz -n agentz-system --type merge --patch-file /dev/stdin <<'EOF'
stringData:
  GITHUB_CLIENT_SECRET: "YOUR_GITHUB_CLIENT_SECRET"
EOF
```

Edit `values.yaml` to add the client ID to `web.env`. Setting `githubOrg` will
limit sign-ups to users belonging to that organization.

```yaml
web:
  env:
    githubClientID: "YOUR_GITHUB_CLIENT_ID"
    githubOrg: "your-github-org" # Optional, recommended
```

| Optional setting under `web.env`            | Effect                                                                               |
|---------------------------------------------|--------------------------------------------------------------------------------------|
| `githubOrg: "your-github-org-1,your-org-2"` | Require active membership in this organization. Recommended.                         |
| `githubTeamSlug: "team-1,team-2"`           | Require active membership in this team within `githubOrg`.                           |
| `githubAllowedUserID: "12345678,87654321"`  | Allow only this numeric GitHub user ID, overriding the organization and team checks. |

AgentZ requests `user:email` and `read:org`. If your organization restricts
OAuth apps, an owner must [approve the app](https://docs.github.com/en/organizations/managing-oauth-access-to-your-organizations-data/approving-oauth-apps-for-your-organization)
for membership checks to work.

## Google

[Configure the Google OAuth consent screen](https://developers.google.com/workspace/guides/configure-oauth-consent)
in your Google Cloud project. Select the appropriate audience and add test
users if the app is in testing.

Create an [OAuth client ID](https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred)
with the application type **Web application**:

| Field                         | Value                                                 |
|-------------------------------|-------------------------------------------------------|
| Authorized JavaScript origins | `https://agentz.example.com`                          |
| Authorized redirect URIs      | `https://agentz.example.com/api/auth/callback/google` |

As with GitHub, add the client secret to the existing Secret:

```bash
kubectl patch secret agentz -n agentz-system --type merge --patch-file /dev/stdin <<'EOF'
stringData:
  GOOGLE_CLIENT_SECRET: "YOUR_GOOGLE_CLIENT_SECRET"
EOF
```

Edit `values.yaml` to add the client ID and allowed email domains to `web.env`.
Setting `googleAllowedEmailDomains` will limit sign-ups to Google accounts
with email addresses in those domains.

```yaml
web:
  env:
    googleClientID: "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com"
    googleAllowedEmailDomains: "example.com,subsidiary.com" # Optional, recommended
```

Go back and continue the [quickstart guide](./README.md#install-agentz).
