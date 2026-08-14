"use client"

import Link from "next/link"
import { Fragment, useActionState, useEffect, useMemo, useState } from "react"
import { GitHubDark, GitHubLight, Google } from "@ridemountainpig/svgl-react"
import { ArrowRight, CircleAlert, Info, Plus, Save, X } from "lucide-react"
import { socialAdmissionAction, type SocialAdmissionFormState } from "@/app/(scoped)/orgs/actions"
import type { SocialAdmission } from "@/data/members"
import type { EventTrailFilter } from "@/lib/gateway/client"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Input } from "@/components/ui/input"
import { MultiSelectDropdown } from "@/components/ui/multi-select-dropdown"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

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
  const [accessInvalid, setAccessInvalid] = useState(false)
  const [actionState, setActionState] = useState(state)
  if (actionState !== state) {
    setActionState(state)
    if (state.saved) setDirty(false)
  }

  const githubInvalid = rules.some(
    (rule) =>
      !githubOrganizationPattern.test(rule.organization.trim()) ||
      (rule.team !== null && rule.team !== "" && !githubTeamPattern.test(rule.team.trim()))
  )
  const hasDefaultAccess = roleIds.length + teamIds.length > 0
  const invalid = enabled && (githubInvalid || Boolean(domainError))
  const qualifiedWorkspaces = useMemo(
    () =>
      data.workspaces.flatMap((workspace) => {
        const sources = [
          ...data.roles
            .filter((role) => roleIds.includes(role.id) && role.workspaceIds.includes(workspace.id))
            .map((role) => ({ kind: "Role", name: role.name })),
          ...data.teams
            .filter((team) => teamIds.includes(team.id) && team.workspaceIds.includes(workspace.id))
            .map((team) => ({ kind: "Team", name: team.name })),
        ]
        return sources.length ? [{ ...workspace, sources }] : []
      }),
    [data.roles, data.teams, data.workspaces, roleIds, teamIds]
  )
  const submittedRoleIds = enabled ? roleIds : data.defaultRoleIds
  const submittedTeamIds = enabled ? teamIds : data.defaultTeamIds
  const submittedDomains = enabled ? domains : data.googleDomains
  const submittedRules = enabled ? rules : data.githubRules

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
    setDomains((current) => [...current, value])
    setDomain("")
    setDirty(true)
  }

  return (
    <form
      action={action}
      className="flex max-w-4xl min-w-0 flex-col gap-8 px-4 pb-6 md:px-6"
      onChange={() => setDirty(true)}
      onSubmit={(event) => {
        if (!enabled || hasDefaultAccess) return
        event.preventDefault()
        setAccessInvalid(true)
      }}
    >
      {submittedRoleIds.map((id) => (
        <input key={id} name="role_ids" type="hidden" value={id} />
      ))}
      {submittedTeamIds.map((id) => (
        <input key={id} name="team_ids" type="hidden" value={id} />
      ))}
      {submittedDomains.map((value) => (
        <input key={value} name="google_domains" type="hidden" value={value} />
      ))}
      {submittedRules.map((rule) => (
        <Fragment key={rule.id}>
          <input name="github_organization" type="hidden" value={rule.organization} />
          <input name="github_team" type="hidden" value={rule.team ?? ""} />
        </Fragment>
      ))}

      <section className="flex flex-col gap-5">
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="social-admission-enabled">Enable Social Sign Up</FieldLabel>
            <FieldDescription>
              Let people join this Organisation when they match the access rules below.
            </FieldDescription>
          </FieldContent>
          <Switch
            aria-label="Enable Social Sign Up"
            checked={enabled}
            id="social-admission-enabled"
            name="enabled"
            onCheckedChange={(checked) => {
              setEnabled(checked)
              setAccessInvalid(false)
              setDomainError(undefined)
              setDirty(true)
            }}
          />
        </Field>
        {state.error ? (
          <Alert
            className="-mx-4 w-[100cqw] max-w-none rounded-none border-x-0 px-4 md:-mx-6 md:px-6"
            variant="destructive"
          >
            <CircleAlert aria-hidden="true" />
            <AlertTitle>Policy not saved</AlertTitle>
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        ) : null}
        {enabled && !hasDefaultAccess ? (
          <Alert
            className="-mx-4 w-[100cqw] max-w-none rounded-none border-x-0 px-4 md:-mx-6 md:px-6"
            variant="warning"
          >
            <CircleAlert aria-hidden="true" />
            <AlertTitle>Default access required</AlertTitle>
            <AlertDescription>
              Select at least one default role or team before saving Social Sign Up.
            </AlertDescription>
          </Alert>
        ) : null}
      </section>

      {enabled ? (
        <>
          <section className="flex flex-col gap-5">
            <div className="flex flex-col gap-1">
              <h3 className="text-base font-semibold">Default access</h3>
              <p className="text-muted-foreground text-sm">
                Assign roles and teams once when a qualifying account joins.
              </p>
            </div>
            <FieldGroup
              className="grid md:grid-cols-2"
              data-invalid={accessInvalid && !hasDefaultAccess}
            >
              <Field data-invalid={accessInvalid && !hasDefaultAccess}>
                <FieldLabel htmlFor="default-roles">Default roles</FieldLabel>
                <MultiSelectDropdown
                  emptyMessage="No roles available."
                  id="default-roles"
                  invalid={accessInvalid && !hasDefaultAccess}
                  onValueChangeAction={(value) => {
                    setRoleIds(value)
                    if (value.length + teamIds.length > 0) setAccessInvalid(false)
                    setDirty(true)
                  }}
                  options={data.roles.map((role) => ({ label: role.name, value: role.id }))}
                  placeholder="Select default roles"
                  searchPlaceholder="Search roles..."
                  value={roleIds}
                />
              </Field>
              <Field data-invalid={accessInvalid && !hasDefaultAccess}>
                <FieldLabel htmlFor="default-teams">Default teams</FieldLabel>
                <MultiSelectDropdown
                  emptyMessage="No teams available."
                  id="default-teams"
                  invalid={accessInvalid && !hasDefaultAccess}
                  onValueChangeAction={(value) => {
                    setTeamIds(value)
                    if (roleIds.length + value.length > 0) setAccessInvalid(false)
                    setDirty(true)
                  }}
                  options={data.teams.map((team) => ({ label: team.name, value: team.id }))}
                  placeholder="Select default teams"
                  searchPlaceholder="Search teams..."
                  value={teamIds}
                />
              </Field>
              {accessInvalid && !hasDefaultAccess ? (
                <FieldError className="md:col-span-2">
                  Select at least one default role or team.
                </FieldError>
              ) : null}
            </FieldGroup>

            <div className="flex flex-col gap-3 pt-2">
              <div className="flex flex-col gap-1">
                <h4 className="text-sm font-medium">Qualified workspaces</h4>
                <p className="text-muted-foreground text-sm">
                  Workspaces reached through the selected default roles and teams.
                </p>
              </div>
              <div className="-mx-4 w-[100cqw] min-w-0 border-b md:-mx-6">
                <Table aria-label="Qualified workspaces" className="w-full table-fixed">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-2/5">Workspace</TableHead>
                      <TableHead>Granted through</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {qualifiedWorkspaces.length ? (
                      qualifiedWorkspaces.map((workspace) => (
                        <TableRow key={workspace.id}>
                          <TableCell className="font-medium whitespace-normal">
                            {workspace.name}
                          </TableCell>
                          <TableCell className="whitespace-normal">
                            <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1">
                              {workspace.sources.map((source) => (
                                <span key={`${source.kind}:${source.name}`}>
                                  <span className="text-foreground font-medium">{source.kind}</span>
                                  {" · "}
                                  {source.name}
                                </span>
                              ))}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell
                          className="text-muted-foreground h-24 text-center whitespace-normal"
                          colSpan={2}
                        >
                          No workspaces are granted by the selected defaults
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </section>

          <section className="flex flex-col gap-6">
            <div className="flex flex-col gap-1">
              <h3 className="text-base font-semibold">External rules</h3>
              <p className="text-muted-foreground text-sm">
                Define which Google and GitHub accounts qualify to join.
              </p>
            </div>

            <div className="grid gap-5 md:grid-cols-[11rem_minmax(0,1fr)]">
              <ProviderHeading
                description="Allow exact email domains."
                icon={<Google aria-hidden className="size-5" />}
                title="Google"
              />
              <Field data-invalid={Boolean(domainError)}>
                <FieldLabel htmlFor="google-domains">Email domain</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    aria-describedby={domainError ? "google-domains-error" : undefined}
                    aria-invalid={Boolean(domainError)}
                    autoComplete="off"
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
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton onClick={addDomain}>
                      <Plus data-icon="inline-start" />
                      Add
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
                <FieldError id="google-domains-error">{domainError}</FieldError>
                {domains.length ? (
                  <div className="mt-1 flex flex-col">
                    {domains.map((value, index) => (
                      <Fragment key={value}>
                        {index ? <Separator /> : null}
                        <div className="flex min-w-0 items-center gap-2 py-2">
                          <span className="min-w-0 flex-1 truncate text-sm">{value}</span>
                          <Button
                            aria-label={`Remove ${value}`}
                            onClick={() => {
                              setDomains((current) =>
                                current.filter((candidate) => candidate !== value)
                              )
                              setDirty(true)
                            }}
                            size="icon-sm"
                            type="button"
                            variant="ghost"
                          >
                            <X />
                          </Button>
                        </div>
                      </Fragment>
                    ))}
                  </div>
                ) : (
                  <FieldDescription>No Google domains configured.</FieldDescription>
                )}
              </Field>
            </div>

            <Separator className="-mx-4 w-[100cqw] md:-mx-6" />

            <div className="grid gap-5 md:grid-cols-[11rem_minmax(0,1fr)]">
              <ProviderHeading
                description="Allow an organization or one of its teams."
                icon={
                  <>
                    <GitHubLight aria-hidden className="size-5 dark:hidden" />
                    <GitHubDark aria-hidden className="hidden size-5 dark:block" />
                  </>
                }
                title="GitHub"
              />
              <FieldGroup>
                {rules.length ? (
                  rules.map((rule, index) => {
                    const organizationInvalid = !githubOrganizationPattern.test(
                      rule.organization.trim()
                    )
                    const teamInvalid =
                      rule.team !== null &&
                      rule.team !== "" &&
                      !githubTeamPattern.test(rule.team.trim())
                    const errorId = `github-rule-${rule.id}-error`
                    return (
                      <Fragment key={rule.id}>
                        {index ? <Separator /> : null}
                        <Field data-invalid={organizationInvalid || teamInvalid}>
                          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
                            <Field>
                              <FieldLabel htmlFor={`github-organization-${rule.id}`}>
                                Organization
                              </FieldLabel>
                              <Input
                                aria-describedby={organizationInvalid ? errorId : undefined}
                                aria-invalid={organizationInvalid}
                                autoComplete="off"
                                id={`github-organization-${rule.id}`}
                                onChange={(event) =>
                                  setRules((current) =>
                                    current.map((candidate, candidateIndex) =>
                                      candidateIndex === index
                                        ? { ...candidate, organization: event.target.value }
                                        : candidate
                                    )
                                  )
                                }
                                placeholder="acme"
                                value={rule.organization}
                              />
                            </Field>
                            <Field>
                              <FieldLabel htmlFor={`github-team-${rule.id}`}>
                                Team slug <span className="text-muted-foreground">(optional)</span>
                              </FieldLabel>
                              <Input
                                aria-describedby={teamInvalid ? errorId : undefined}
                                aria-invalid={teamInvalid}
                                autoComplete="off"
                                id={`github-team-${rule.id}`}
                                onChange={(event) =>
                                  setRules((current) =>
                                    current.map((candidate, candidateIndex) =>
                                      candidateIndex === index
                                        ? { ...candidate, team: event.target.value || null }
                                        : candidate
                                    )
                                  )
                                }
                                placeholder="platform"
                                value={rule.team ?? ""}
                              />
                            </Field>
                            <Button
                              aria-label={`Remove GitHub rule ${index + 1}`}
                              onClick={() => {
                                setRules((current) =>
                                  current.filter((_, candidateIndex) => candidateIndex !== index)
                                )
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
                            <FieldError id={errorId}>
                              {organizationInvalid
                                ? "Enter a valid GitHub organization name."
                                : "Enter a lowercase GitHub team slug."}
                            </FieldError>
                          ) : null}
                        </Field>
                      </Fragment>
                    )
                  })
                ) : (
                  <FieldDescription>No GitHub rules configured.</FieldDescription>
                )}
                <Button
                  className="w-fit"
                  onClick={() => {
                    const id = crypto.randomUUID()
                    setRules((current) => [...current, { id, organization: "", team: null }])
                    setDirty(true)
                  }}
                  type="button"
                  variant="outline"
                >
                  <Plus data-icon="inline-start" />
                  Add GitHub rule
                </Button>
              </FieldGroup>
            </div>
          </section>

          <Alert
            className="-mx-4 w-[100cqw] max-w-none rounded-none border-x-0 px-4 md:-mx-6 md:px-6"
            variant="info"
          >
            <Info aria-hidden="true" />
            <AlertTitle>Membership lifecycle</AlertTitle>
            <AlertDescription>
              These rules are evaluated only when a qualifying Social account joins this
              Organisation. Default access is assigned once; later sign-ins do not recalculate or
              remove it. Explicit Invitations bypass Social Admission rules and grant their
              configured access to the signed-in User who accepts the link first.
            </AlertDescription>
          </Alert>

          <section className="flex flex-col gap-3">
            <h3 className="text-base font-semibold">Join links</h3>
            <JoinLink label="Google" link={data.joinLinks.google} />
            <JoinLink label="GitHub" link={data.joinLinks.github} />
            <Button asChild className="w-fit" variant="link">
              <Link
                href={{
                  pathname: `/orgs/${orgSlug}/event-trail`,
                  query: {
                    filters: JSON.stringify([
                      { field: "category", values: ["membership"] },
                      {
                        field: "target_type",
                        values: ["organization_membership"],
                      },
                    ] satisfies EventTrailFilter[]),
                  },
                }}
              >
                Review membership event trail
                <ArrowRight data-icon="inline-end" />
              </Link>
            </Button>
          </section>
        </>
      ) : null}

      <div className="-mx-4 flex w-[100cqw] justify-end border-t px-4 pt-6 md:-mx-6 md:px-6">
        <Button disabled={pending || invalid} type="submit">
          {pending ? <Spinner /> : <Save data-icon="inline-start" />}
          {pending ? "Saving..." : "Save Admission Policy"}
        </Button>
      </div>
    </form>
  )
}

function ProviderHeading({
  description,
  icon,
  title,
}: {
  description: string
  icon: React.ReactNode
  title: string
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
        {icon}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <h4 className="text-sm font-medium">{title}</h4>
        <p className="text-muted-foreground text-xs leading-relaxed">{description}</p>
      </div>
    </div>
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
