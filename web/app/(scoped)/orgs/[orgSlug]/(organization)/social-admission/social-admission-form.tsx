"use client"

import type { Route } from "next"
import Link from "next/link"
import { useActionState, useEffect, useMemo, useState } from "react"
import { ArrowRight, CircleAlert, Plus, Save, X } from "lucide-react"
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

const googleDomainPattern =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/
const githubOrganizationPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const githubTeamPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function SocialAdmissionForm({ data, orgSlug }: { data: SocialAdmission; orgSlug: string }) {
  const [state, action, pending] = useActionState<SocialAdmissionFormState, FormData>(
    socialAdmissionAction.bind(null, orgSlug),
    {}
  )
  const [domains, setDomains] = useState(data.googleDomains)
  const [domain, setDomain] = useState("")
  const [domainError, setDomainError] = useState<string>()
  const [rules, setRules] = useState(data.githubRules)
  const [enabled, setEnabled] = useState(data.enabled)
  const [roleIds, setRoleIds] = useState(data.defaultRoleIds)
  const [teamIds, setTeamIds] = useState(data.defaultTeamIds)
  const [dirty, setDirty] = useState(false)
  const [actionState, setActionState] = useState(state)
  if (actionState !== state) {
    setActionState(state)
    if (state.saved) setDirty(false)
  }
  const githubInvalid = rules.some(
    (rule) =>
      !githubOrganizationPattern.test(rule.organization.trim()) ||
      (Boolean(rule.team) && !githubTeamPattern.test(rule.team?.trim() ?? ""))
  )
  const invalid = (enabled && roleIds.length === 0) || githubInvalid || Boolean(domainError)
  const workspaceIds = useMemo(() => {
    const ids = new Set<string>()
    data.roles
      .filter((role) => roleIds.includes(role.id))
      .forEach((role) => role.workspaceIds.forEach((id) => ids.add(id)))
    data.teams
      .filter((team) => teamIds.includes(team.id))
      .forEach((team) => team.workspaceIds.forEach((id) => ids.add(id)))
    return ids
  }, [data.roles, data.teams, roleIds, teamIds])

  useEffect(() => {
    if (!dirty) return
    const guard = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener("beforeunload", guard)
    return () => window.removeEventListener("beforeunload", guard)
  }, [dirty])

  function addDomain() {
    const value = domain.trim().toLowerCase()
    if (!googleDomainPattern.test(value)) {
      setDomainError("Enter an exact email domain such as example.com.")
      return
    }
    setDomainError(undefined)
    if (domains.includes(value)) {
      setDomain("")
      return
    }
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
          <Switch
            aria-label="Enable guarded Social sign-up"
            id="social-admission-enabled"
            checked={enabled}
            name="enabled"
            onCheckedChange={(checked) => setEnabled(checked)}
          />
          <div className="grid gap-1">
            <FieldLabel htmlFor="social-admission-enabled">
              Enable guarded Social sign-up
            </FieldLabel>
          </div>
        </Field>
        {state.error ? (
          <Alert variant="destructive">
            <AlertTitle>Policy not saved</AlertTitle>
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        ) : null}
        {enabled && roleIds.length === 0 ? (
          <Alert variant="warning">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>Default Role required</AlertTitle>
            <AlertDescription>
              Select at least one default Role before enabling Social sign-up.
            </AlertDescription>
          </Alert>
        ) : null}
      </section>

      <section className="grid gap-4">
        <h3 className="text-base font-semibold">Default access</h3>
        <div className="grid gap-6 md:grid-cols-2">
          <CheckList
            label="Default roles"
            name="role_ids"
            onChange={setRoleIds}
            options={data.roles}
            value={roleIds}
          />
          <CheckList
            label="Default teams"
            name="team_ids"
            onChange={setTeamIds}
            options={data.teams}
            value={teamIds}
          />
        </div>
        <div className="grid gap-3 border-y py-4">
          <div>
            <h4 className="text-sm font-medium">Derived Workspace access</h4>
            <p className="text-muted-foreground text-sm">
              Qualifying members can enter Workspaces reached by the selected Roles and Teams.
            </p>
          </div>
          {data.workspaces.length === 0 ? (
            <p className="text-muted-foreground text-sm">No active Workspaces</p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {data.workspaces.map((workspace) => (
                <li className="flex items-center gap-2 text-sm" key={workspace.id}>
                  <span
                    aria-hidden="true"
                    className={
                      workspaceIds.has(workspace.id)
                        ? "bg-primary size-2 rounded-full"
                        : "bg-muted-foreground/35 size-2 rounded-full"
                    }
                  />
                  <span>{workspace.name}</span>
                  <span className="text-muted-foreground ml-auto">
                    {workspaceIds.has(workspace.id) ? "Granted" : "No access"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="grid gap-5">
        <h3 className="text-base font-semibold">External rules</h3>
        <Field>
          <FieldLabel htmlFor="google-domains">Google email domains</FieldLabel>
          <div className="flex gap-2">
            <Input
              aria-describedby={domainError ? "google-domains-error" : undefined}
              aria-invalid={Boolean(domainError)}
              id="google-domains"
              onChange={(event) => setDomain(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return
                event.preventDefault()
                addDomain()
              }}
              placeholder="example.com"
              value={domain}
            />
            <Button onClick={addDomain} type="button" variant="outline">
              <Plus />
              Add
            </Button>
          </div>
          {domainError ? (
            <p className="text-destructive text-sm" id="google-domains-error" role="alert">
              {domainError}
            </p>
          ) : null}
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
          {rules.map((rule, index) => {
            const organizationInvalid = !githubOrganizationPattern.test(rule.organization.trim())
            const teamInvalid =
              Boolean(rule.team) && !githubTeamPattern.test(rule.team?.trim() ?? "")
            const errorId = `github-rule-${rule.id}-error`
            return (
              <div className="grid gap-2" key={rule.id}>
                <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                  <Input
                    aria-describedby={organizationInvalid ? errorId : undefined}
                    aria-invalid={organizationInvalid}
                    aria-label={`GitHub organization rule ${index + 1}`}
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
                    aria-describedby={teamInvalid ? errorId : undefined}
                    aria-invalid={teamInvalid}
                    aria-label={`GitHub team rule ${index + 1}`}
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
                {organizationInvalid || teamInvalid ? (
                  <p className="text-destructive text-sm" id={errorId} role="alert">
                    {organizationInvalid
                      ? "Enter a valid GitHub organization name."
                      : "Enter a lowercase GitHub team slug."}
                  </p>
                ) : null}
              </div>
            )
          })}
          <Button
            className="w-fit"
            onClick={() => {
              const id =
                crypto.randomUUID?.() ?? crypto.getRandomValues(new Uint32Array(4)).join("-")
              setRules([...rules, { id, organization: "", team: null }])
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

      <Alert>
        <AlertTitle>Membership lifecycle</AlertTitle>
        <AlertDescription>
          These rules are evaluated only when a qualifying Social account joins this Organisation.
          Default access is assigned once; later sign-ins do not recalculate or remove it. Explicit
          Invitations bypass Social Admission rules and continue to enforce email equality.
        </AlertDescription>
      </Alert>

      <section className="grid gap-3">
        <h3 className="text-base font-semibold">Join links</h3>
        <JoinLink label="Google" link={data.joinLinks.google} />
        <JoinLink label="GitHub" link={data.joinLinks.github} />
        <Button asChild className="w-fit" variant="link">
          <Link
            href={
              `/orgs/${orgSlug}/event-trail?category=membership&target_type=organization` as Route
            }
          >
            Review Social Admission eventTrail events
            <ArrowRight />
          </Link>
        </Button>
      </section>

      <div className="flex justify-end">
        <Button disabled={pending || invalid} type="submit">
          {pending ? <Spinner /> : <Save />}
          Save social admission
        </Button>
      </div>
    </form>
  )
}

function CheckList({
  label,
  name,
  onChange,
  options,
  value,
}: {
  label: string
  name: string
  onChange: (value: string[]) => void
  options: { id: string; name: string }[]
  value: string[]
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
                aria-label={`${label}: ${option.name}`}
                checked={value.includes(option.id)}
                name={name}
                onCheckedChange={(checked) =>
                  onChange(
                    checked
                      ? [...value, option.id]
                      : value.filter((candidate) => candidate !== option.id)
                  )
                }
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
