import { GoogleCloud } from "@ridemountainpig/svgl-react"
import { Settings2 } from "lucide-react"
import type { ComponentType, SVGProps } from "react"

export type OAuthSecretCatalogItem = {
  id: "custom" | "gws"
  name: string
  description: string
  key: string
  hosts: string[]
  serverUrl: string
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint?: string
  resource: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
  scopes: string[]
}

export const oauthSecretCatalog: OAuthSecretCatalogItem[] = [
  {
    id: "custom",
    name: "Custom",
    description: "Enter the OAuth endpoints and client credentials yourself",
    key: "",
    hosts: [],
    serverUrl: "",
    issuer: "",
    authorizationEndpoint: "",
    tokenEndpoint: "",
    resource: "",
    icon: Settings2,
    scopes: [],
  },
  {
    id: "gws",
    name: "Google Workspace CLI",
    description: "Create an OAuth access token for the Google Workspace CLI",
    key: "GOOGLE_WORKSPACE_CLI_TOKEN",
    hosts: ["*.googleapis.com", "**.googleapis.com"],
    serverUrl: "https://www.googleapis.com/",
    issuer: "https://accounts.google.com",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    resource: "https://www.googleapis.com/",
    icon: GoogleCloud,
    scopes: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/spreadsheets.readonly",
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/documents.readonly",
      "https://www.googleapis.com/auth/presentations",
      "https://www.googleapis.com/auth/presentations.readonly",
      "https://www.googleapis.com/auth/tasks",
      "https://www.googleapis.com/auth/contacts.readonly",
    ],
  },
]

export function findOAuthSecretCatalogByServerURL(
  serverURL: string
): OAuthSecretCatalogItem | undefined {
  return oauthSecretCatalog.find((item) => item.serverUrl !== "" && item.serverUrl === serverURL)
}
