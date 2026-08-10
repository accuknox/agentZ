"use client"

import { useActionState, useEffect, useState } from "react"
import { GitFork, Plus, Save, X } from "lucide-react"
import { socialAdmissionAction, type SocialAdmissionFormState } from "@/app/(scoped)/orgs/actions"
import type { SocialAdmission } from "@/data/members"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { CopyButton } from "@/components/ui/copy-button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"

export function SocialAdmissionForm({ data, orgSlug }: { data: SocialAdmission; orgSlug: string }) {
  const [state, action, pending] = useActionState<SocialAdmissionFormState, FormData>(
    socialAdmissionAction.bind(null, orgSlug),
    {}
  )
  const [domains, setDomains] = useState(data.googleDomains)
  const [domain, setDomain] = useState("")
  const [rules, setRules] = useState(data.githubRules)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (!dirty) return
    const guard = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener("beforeunload", guard)
    return () => window.removeEventListener("beforeunload", guard)
  }, [dirty])

  function addDomain() {
    const value = domain.trim().toLowerCase()
    if (!value || domains.includes(value)) return
    setDomains([...domains, value])
    setDomain("")
    setDirty(true)
  }

  return (
    <form action={action} className="flex min-w-0 flex-col gap-6" onChange={() => setDirty(true)}>
      <Card>
        <CardHeader>
          <CardTitle>Social Admission</CardTitle>
          <CardDescription>
            Rules run only when a social provider creates a new Organisation Membership. Later
            sign-in never silently removes access; AgentZ disable/remove remains authoritative.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <Field orientation="horizontal">
            <Switch defaultChecked={data.enabled} name="enabled" />
            <div className="grid gap-1">
              <FieldLabel>Enable guarded Social sign-up</FieldLabel>
              <FieldDescription>
                Requires at least one default Role and one matching Google or GitHub rule.
              </FieldDescription>
            </div>
          </Field>
          {state.error ? (
            <Alert variant="destructive">
              <AlertTitle>Policy not saved</AlertTitle>
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Default Access</CardTitle>
          <CardDescription>
            Default Roles are required when enabled. Default Teams are optional.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <CheckList
            defaults={data.defaultRoleIds}
            label="Default Roles"
            name="role_ids"
            options={data.roles}
          />
          <CheckList
            defaults={data.defaultTeamIds}
            label="Default Teams"
            name="team_ids"
            options={data.teams}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>External Rules</CardTitle>
          <CardDescription>
            Google domains are exact matches after lowercasing. Subdomains do not match unless
            listed separately.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <Field>
            <FieldLabel htmlFor="google-domains">Google email domains</FieldLabel>
            <div className="flex gap-2">
              <Input
                id="google-domains"
                onChange={(event) => setDomain(event.target.value)}
                placeholder="example.com"
                value={domain}
              />
              <Button onClick={addDomain} type="button" variant="outline">
                <Plus />
                Add
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {domains.map((value) => (
                <Badge className="gap-1" key={value} variant="outline">
                  {value}
                  <button
                    aria-label={`Remove ${value}`}
                    onClick={() => {
                      setDomains(domains.filter((candidate) => candidate !== value))
                      setDirty(true)
                    }}
                    type="button"
                  >
                    <X className="size-3" />
                  </button>
                  <input name="google_domains" type="hidden" value={value} />
                </Badge>
              ))}
            </div>
            <FieldDescription>Domains are exact, lowercase matches.</FieldDescription>
          </Field>
          <div className="grid gap-3">
            <div className="flex items-center gap-2">
              <GitFork className="size-4" />
              <h3 className="text-sm font-medium">GitHub rules</h3>
            </div>
            {rules.map((rule, index) => (
              <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]" key={rule.id}>
                <Input
                  name="github_organization"
                  onChange={(event) =>
                    setRules(
                      rules.map((candidate, candidateIndex) =>
                        candidateIndex === index
                          ? { ...candidate, organization: event.target.value }
                          : candidate
                      )
                    )
                  }
                  placeholder="GitHub organization"
                  value={rule.organization}
                />
                <Input
                  name="github_team"
                  onChange={(event) =>
                    setRules(
                      rules.map((candidate, candidateIndex) =>
                        candidateIndex === index
                          ? { ...candidate, team: event.target.value || null }
                          : candidate
                      )
                    )
                  }
                  placeholder="Team slug"
                  value={rule.team ?? ""}
                />
                <Button
                  aria-label="Remove GitHub rule"
                  onClick={() => {
                    setRules(rules.filter((_, candidateIndex) => candidateIndex !== index))
                    setDirty(true)
                  }}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <X />
                </Button>
              </div>
            ))}
            <Button
              className="w-fit"
              onClick={() => {
                setRules([...rules, { id: crypto.randomUUID(), organization: "", team: null }])
                setDirty(true)
              }}
              type="button"
              variant="outline"
            >
              <Plus />
              Add GitHub rule
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Join Links</CardTitle>
          <CardDescription>
            These links carry the target Organisation identity into signed Better Auth OAuth state.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <JoinLink label="Google" link={data.joinLinks.google} />
          <JoinLink label="GitHub" link={data.joinLinks.github} />
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button disabled={pending} type="submit">
          {pending ? <Spinner /> : <Save />}
          Save Social Admission
        </Button>
      </div>
    </form>
  )
}

function CheckList({
  defaults,
  label,
  name,
  options,
}: {
  defaults: string[]
  label: string
  name: string
  options: { id: string; name: string }[]
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="text-sm font-medium">{label}</legend>
      {options.length === 0 ? (
        <p className="text-muted-foreground rounded-md border p-3 text-sm">No options available.</p>
      ) : (
        options.map((option) => (
          <label className="flex items-center gap-2 rounded-md border p-2 text-sm" key={option.id}>
            <Checkbox defaultChecked={defaults.includes(option.id)} name={name} value={option.id} />
            <span className="truncate">{option.name}</span>
          </label>
        ))
      )}
    </fieldset>
  )
}

function JoinLink({ label, link }: { label: string; link: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border p-2">
      <Badge variant="outline">{label}</Badge>
      <code className="min-w-0 flex-1 truncate text-xs">{link}</code>
      <CopyButton content={link} />
    </div>
  )
}
