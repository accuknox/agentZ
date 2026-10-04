"use client"

import { useState, useTransition } from "react"
import { Copy, KeyRound, Plus, ShieldCheck, Trash2, Pencil, AppWindow } from "lucide-react"
import { toast } from "sonner"
import { AdministrationPageHeader } from "@/components/administration"
import type { OrganizationSummary } from "@/data/organizations"
import type { oauthClients } from "@/db/auth-schema"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select"
import { changeApplicationAction, delegationSettingAction, saveApplicationAction } from "./actions"

const scopes = [
  { value: "openid", label: "Sign in", description: "Authenticate users with OpenID Connect." },
  { value: "profile", label: "Profile", description: "Read the user's name and profile image." },
  {
    value: "email",
    label: "Email",
    description: "Read the user's email address and verification status.",
  },
  {
    value: "offline_access",
    label: "Offline access",
    description: "Refresh access when the user is away.",
  },
  {
    value: "inference:use",
    label: "Inference",
    description: "Use models explicitly selected by the user.",
  },
  {
    value: "mcp:use",
    label: "MCP",
    description: "Use tools, prompts and resources explicitly selected by the user.",
  },
] as const

type Application = Pick<
  typeof oauthClients.$inferSelect,
  | "clientId"
  | "name"
  | "redirectUris"
  | "scopes"
  | "tokenEndpointAuthMethod"
  | "applicationType"
  | "disabled"
>

export function Applications({
  organization,
  clients,
  delegationEnabled,
}: {
  organization: OrganizationSummary
  clients: Application[]
  delegationEnabled: boolean
}) {
  const [pending, startTransition] = useTransition()
  const [editor, setEditor] = useState<Application | "new">()
  const [name, setName] = useState("")
  const [type, setType] = useState<"confidential" | "browser" | "native">("confidential")
  const [redirects, setRedirects] = useState("")
  const [selectedScopes, setSelectedScopes] = useState<string[]>(["openid", "profile", "email"])
  const [error, setError] = useState<string>()
  const [credential, setCredential] = useState<{ clientId: string; secret: string }>()
  const [confirmation, setConfirmation] = useState<
    { client: Application; operation: "delete" | "rotate" | "disable" } | "delegation"
  >()

  function openEditor(client: Application | "new") {
    setEditor(client)
    setName(client === "new" ? "" : (client.name ?? ""))
    let clientType: "confidential" | "browser" | "native" = "confidential"
    if (client !== "new" && client.tokenEndpointAuthMethod === "none") {
      clientType = client.applicationType === "native" ? "native" : "browser"
    }
    setType(clientType)
    setRedirects(client === "new" ? "" : client.redirectUris.join("\n"))
    setSelectedScopes(client === "new" ? ["openid", "profile", "email"] : (client.scopes ?? []))
    setError(undefined)
  }

  let confirmationTitle = "Disable application?"
  let confirmationDescription =
    "Existing access is revoked for new requests. Work already dispatched may finish. Users must grant access again after re-enabling."
  if (confirmation === "delegation") {
    confirmationTitle = "Turn off resource delegation?"
  } else if (confirmation?.operation === "delete") {
    confirmationTitle = "Delete application?"
    confirmationDescription =
      "This permanently deletes the application and revokes its authorizations. Work already dispatched may finish."
  } else if (confirmation?.operation === "rotate") {
    confirmationTitle = "Rotate client secret?"
    confirmationDescription =
      "The old secret stops working immediately. Update the application with the new secret."
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-6">
      <AdministrationPageHeader
        title="Applications"
        description="Let other applications sign in with AgentZ and request access to user-selected resources."
        scope={{ kind: "organization", organizationName: organization.name }}
        actions={
          <Button onClick={() => openEditor("new")}>
            <Plus aria-hidden="true" />
            Create application
          </Button>
        }
      />
      <div className="space-y-6 px-4 pb-8 md:px-6">
        <section className="flex items-start justify-between gap-6 rounded-lg border p-4">
          <div className="space-y-1">
            <h2 className="flex items-center gap-2 font-semibold">
              <ShieldCheck className="size-4" aria-hidden="true" />
              Resource delegation
            </h2>
            <p className="text-muted-foreground max-w-2xl text-sm">
              Allow members to grant external applications access to this organization’s models and
              MCP capabilities. Members also need Use and Delegate permissions. Sign-in and profile
              sharing remain available.
            </p>
            <p className="text-muted-foreground text-sm">
              Turning this off revokes existing resource access. Turning it back on requires fresh
              consent.
            </p>
          </div>
          <Switch
            aria-label="Allow resource delegation"
            checked={delegationEnabled}
            disabled={pending}
            onCheckedChange={(enabled) => {
              if (!enabled) {
                setConfirmation("delegation")
                return
              }
              startTransition(async () => {
                const result = await delegationSettingAction(organization.id, true)
                if ("error" in result) toast.error(result.error)
                else toast.success("Resource delegation enabled")
              })
            }}
          />
        </section>
        {clients.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center">
            <AppWindow className="text-muted-foreground size-8" aria-hidden="true" />
            <h2 className="font-semibold">Your first application</h2>
            <p className="text-muted-foreground max-w-md text-sm">
              Register an application to offer Sign in with AgentZ. Users choose which resources it
              can use.
            </p>
            <Button variant="outline" onClick={() => openEditor("new")}>
              Create application
            </Button>
          </div>
        ) : (
          <div className="divide-y rounded-lg border">
            {clients.map((client) => {
              let clientLabel = "Confidential backend"
              if (client.tokenEndpointAuthMethod === "none") {
                clientLabel =
                  client.applicationType === "native" ? "Native application" : "Browser application"
              }
              return (
                <article key={client.clientId} className="space-y-3 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <h2 className="flex items-center gap-2 font-semibold">
                        {client.name}
                        <Badge variant={client.disabled ? "secondary" : "success"}>
                          {client.disabled ? "Disabled" : "Active"}
                        </Badge>
                      </h2>
                      <div className="flex items-center gap-2">
                        <code className="text-muted-foreground text-xs break-all">
                          {client.clientId}
                        </code>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Copy client ID for ${client.name}`}
                          onClick={async () => {
                            await navigator.clipboard.writeText(client.clientId)
                            toast.success("Client ID copied")
                          }}
                        >
                          <Copy aria-hidden="true" />
                        </Button>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => openEditor(client)}
                      >
                        <Pencil aria-hidden="true" />
                        Edit
                      </Button>
                      {client.tokenEndpointAuthMethod !== "none" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={pending}
                          onClick={() => setConfirmation({ client, operation: "rotate" })}
                        >
                          <KeyRound aria-hidden="true" />
                          Rotate secret
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => {
                          if (!client.disabled) {
                            setConfirmation({ client, operation: "disable" })
                            return
                          }
                          startTransition(async () => {
                            const result = await changeApplicationAction(
                              organization.id,
                              client.clientId,
                              "enable"
                            )
                            if ("error" in result) toast.error(result.error)
                            else toast.success("Application enabled")
                          })
                        }}
                      >
                        {client.disabled ? "Enable" : "Disable"}
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Delete ${client.name}`}
                        disabled={pending}
                        onClick={() => setConfirmation({ client, operation: "delete" })}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {client.scopes?.map((scope) => (
                      <Badge key={scope} variant="outline">
                        {scope}
                      </Badge>
                    ))}
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {clientLabel} · S256 PKCE required
                  </p>
                  <ul className="text-muted-foreground space-y-1 text-xs break-all">
                    {client.redirectUris.map((uri) => (
                      <li key={uri}>{uri}</li>
                    ))}
                  </ul>
                </article>
              )
            })}
          </div>
        )}
      </div>
      <Dialog
        open={editor !== undefined}
        onOpenChange={(open) => {
          if (!pending && !open) setEditor(undefined)
        }}
      >
        <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {editor === "new" ? "Create application" : "Edit application"}
            </DialogTitle>
            <DialogDescription>
              Register exact callback URLs and the scopes this application may request.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault()
              setError(undefined)
              startTransition(async () => {
                const result = await saveApplicationAction(
                  organization.id,
                  {
                    name,
                    type,
                    redirectUris: redirects
                      .split("\n")
                      .map((uri) => uri.trim())
                      .filter(Boolean),
                    scopes: selectedScopes,
                  },
                  editor === "new" ? undefined : editor?.clientId
                )
                if ("error" in result) {
                  setError(result.error)
                  return
                }
                setEditor(undefined)
                if ("secret" in result && result.secret)
                  setCredential({ clientId: result.clientId, secret: result.secret })
                toast.success("Application saved")
              })
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="application-name">Name</Label>
              <Input
                id="application-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={100}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="application-type">Client type</Label>
              <Select
                value={type}
                disabled={editor !== "new"}
                onValueChange={(value: "confidential" | "browser" | "native") => setType(value)}
              >
                <SelectTrigger id="application-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="confidential">Confidential backend</SelectItem>
                  <SelectItem value="browser">Public browser application</SelectItem>
                  <SelectItem value="native">Public native application</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                Public clients use PKCE without a client secret. Keep backend secrets on your
                server.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="application-redirects">Callback URLs</Label>
              <Textarea
                id="application-redirects"
                value={redirects}
                onChange={(event) => setRedirects(event.target.value)}
                required
                placeholder="https://app.example.com/auth/agentz/callback"
              />
              <p className="text-muted-foreground text-xs">
                One URL per line. Web clients need HTTPS on a public hostname. Native clients can
                use HTTP loopback URLs or a reverse-domain URI scheme.
              </p>
            </div>
            <fieldset className="space-y-3">
              <legend className="mb-2 text-sm font-medium">Allowed scopes</legend>
              {scopes.map((scope) => (
                <label key={scope.value} className="flex cursor-pointer items-start gap-3">
                  <Checkbox
                    className="mt-0.5"
                    checked={selectedScopes.includes(scope.value)}
                    onCheckedChange={(checked) =>
                      setSelectedScopes((current) =>
                        checked === true
                          ? [...current, scope.value]
                          : current.filter((value) => value !== scope.value)
                      )
                    }
                  />
                  <span>
                    <span className="text-sm font-medium">
                      {scope.label}{" "}
                      <code className="text-muted-foreground text-xs">{scope.value}</code>
                    </span>
                    <span className="text-muted-foreground block text-xs">{scope.description}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                disabled={pending}
                onClick={() => setEditor(undefined)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending || !selectedScopes.length}>
                {pending ? "Saving…" : "Save application"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={credential !== undefined}
        onOpenChange={(open) => {
          if (!open) setCredential(undefined)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Application credentials</DialogTitle>
            <DialogDescription>
              Copy the secret now. AgentZ stores its hash and cannot show it again.
            </DialogDescription>
          </DialogHeader>
          <Label htmlFor="application-client-id">Client ID</Label>
          <Input id="application-client-id" readOnly value={credential?.clientId ?? ""} />
          <Label htmlFor="application-client-secret">Client secret</Label>
          <div className="flex gap-2">
            <Input
              id="application-client-secret"
              readOnly
              type="password"
              value={credential?.secret ?? ""}
              autoComplete="off"
            />
            <Button
              variant="outline"
              aria-label="Copy client secret"
              onClick={async () => {
                if (!credential) return
                await navigator.clipboard.writeText(credential.secret)
                toast.success("Client secret copied")
              }}
            >
              <Copy aria-hidden="true" />
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setCredential(undefined)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={confirmation !== undefined}
        onOpenChange={(open) => {
          if (!pending && !open) setConfirmation(undefined)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmationTitle}</DialogTitle>
            <DialogDescription>{confirmationDescription}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setConfirmation(undefined)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  if (!confirmation) return
                  if (confirmation === "delegation") {
                    const result = await delegationSettingAction(organization.id, false)
                    if ("error" in result) {
                      toast.error(result.error)
                      return
                    }
                  } else {
                    const result = await changeApplicationAction(
                      organization.id,
                      confirmation.client.clientId,
                      confirmation.operation
                    )
                    if ("error" in result) {
                      toast.error(result.error)
                      return
                    }
                    if ("secret" in result && result.secret)
                      setCredential({
                        clientId: confirmation.client.clientId,
                        secret: result.secret,
                      })
                  }
                  setConfirmation(undefined)
                  toast.success("Application settings updated")
                })
              }
            >
              {pending ? "Updating…" : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}
