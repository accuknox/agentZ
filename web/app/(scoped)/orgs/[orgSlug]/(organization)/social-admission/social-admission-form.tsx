"use client"

import { useActionState, useEffect, useState } from "react"
import { Plus, Save, X } from "lucide-react"
import { socialAdmissionAction, type SocialAdmissionFormState } from "@/app/(scoped)/orgs/actions"
import type { SocialAdmission } from "@/data/members"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { CopyButton } from "@/components/ui/copy-button"
import { Field, FieldLabel } from "@/components/ui/field"
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
    <form
      action={action}
      className="flex max-w-4xl min-w-0 flex-col gap-8 px-4 pb-6 md:px-6"
      onChange={() => setDirty(true)}
    >
      <section className="grid gap-5">
        <Field orientation="horizontal">
          <Switch defaultChecked={data.enabled} name="enabled" />
          <div className="grid gap-1">
            <FieldLabel>Enable guarded Social sign-up</FieldLabel>
          </div>
        </Field>
        {state.error ? (
          <Alert variant="destructive">
            <AlertTitle>Policy not saved</AlertTitle>
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        ) : null}
      </section>

      <section className="grid gap-4">
        <h3 className="text-base font-semibold">Default access</h3>
        <div className="grid gap-6 md:grid-cols-2">
          <CheckList
            defaults={data.defaultRoleIds}
            label="Default roles"
            name="role_ids"
            options={data.roles}
          />
          <CheckList
            defaults={data.defaultTeamIds}
            label="Default teams"
            name="team_ids"
            options={data.teams}
          />
        </div>
      </section>

      <section className="grid gap-5">
        <h3 className="text-base font-semibold">External rules</h3>
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
          <div className="grid gap-1">
            {domains.map((value) => (
              <div className="flex items-center gap-2 py-2" key={value}>
                <span className="min-w-0 flex-1 truncate text-sm">{value}</span>
                <Button
                  aria-label={`Remove ${value}`}
                  onClick={() => {
                    setDomains(domains.filter((candidate) => candidate !== value))
                    setDirty(true)
                  }}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <X />
                </Button>
                <input name="google_domains" type="hidden" value={value} />
              </div>
            ))}
          </div>
        </Field>
        <div className="grid gap-3">
          <h3 className="text-sm font-medium">GitHub rules</h3>
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
      </section>

      <section className="grid gap-3">
        <h3 className="text-base font-semibold">Join links</h3>
        <JoinLink label="Google" link={data.joinLinks.google} />
        <JoinLink label="GitHub" link={data.joinLinks.github} />
      </section>

      <div className="flex justify-end">
        <Button disabled={pending} type="submit">
          {pending ? <Spinner /> : <Save />}
          Save social admission
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
        <p className="text-muted-foreground py-3 text-sm">No options available</p>
      ) : (
        <div className="grid gap-1">
          {options.map((option) => (
            <label className="flex items-center gap-2 py-3 text-sm" key={option.id}>
              <Checkbox
                defaultChecked={defaults.includes(option.id)}
                name={name}
                value={option.id}
              />
              <span className="truncate">{option.name}</span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  )
}

function JoinLink({ label, link }: { label: string; link: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3 py-2">
      <span className="w-16 shrink-0 text-sm font-medium">{label}</span>
      <code className="min-w-0 flex-1 truncate text-xs">{link}</code>
      <CopyButton content={link} />
    </div>
  )
}
