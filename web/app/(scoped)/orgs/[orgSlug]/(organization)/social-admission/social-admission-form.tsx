"use client"

import Link from "next/link"
import { Controller, useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { socialAdmissionFormSchema } from "@/data/schema"
import {
  Fragment,
  startTransition,
  useActionState,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
} from "react"
import { toast } from "sonner"
import { GitHubDark, GitHubLight, Google } from "@ridemountainpig/svgl-react"
import {
  ArrowRight,
  CircleAlert,
  Info,
  PanelsTopLeft,
  Plus,
  Save,
  Shield,
  UsersRound,
  X,
  TriangleAlert,
} from "lucide-react"
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
  RequiredIndicator,
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

export function SocialAdmissionForm({ data, orgSlug }: { data: SocialAdmission; orgSlug: string }) {
  const policySchema = useMemo(
    () =>
      z
        .object({
          ...socialAdmissionFormSchema.shape,
          githubOrganizations: z.array(z.string()),
          githubTeams: z.array(z.string()),
          googleDomains: z.array(z.string()),
        })
        .transform((values) => ({
          ...values,
          googleDomains: values.googleEnabled ? values.googleDomains : data.googleDomains,
          githubOrganizations: values.githubEnabled
            ? values.githubOrganizations
            : data.githubRules.map((rule) => rule.organization),
          githubTeams: values.githubEnabled
            ? values.githubTeams
            : data.githubRules.map((rule) => rule.team ?? ""),
        }))
        .pipe(socialAdmissionFormSchema),
    [data.googleDomains, data.githubRules]
  )
  const form = useForm<z.input<typeof policySchema>, undefined, z.output<typeof policySchema>>({
    resolver: zodResolver(policySchema),
    defaultValues: {
      enabled: data.enabled,
      googleEnabled: data.googleEnabled,
      githubEnabled: data.githubEnabled,
      googleDomains: data.googleDomains,
      githubOrganizations: data.githubRules.map((rule) => rule.organization),
      githubTeams: data.githubRules.map((rule) => rule.team ?? ""),
      roleIds: data.defaultRoleIds,
      teamIds: data.defaultTeamIds,
    },
  })
  const [enabled, googleEnabled, githubEnabled, domains, organizations, teams, roleIds, teamIds] =
    useWatch({
      control: form.control,
      name: [
        "enabled",
        "googleEnabled",
        "githubEnabled",
        "googleDomains",
        "githubOrganizations",
        "githubTeams",
        "roleIds",
        "teamIds",
      ],
    })
  const [ruleIds, setRuleIds] = useState(data.githubRules.map((rule) => rule.id))
  const rules = ruleIds.map((id, index) => ({
    id,
    organization: organizations[index],
    team: teams[index],
  }))
  const dirty = form.formState.isDirty
  const validationVisible = form.formState.submitCount > 0
  const [state, action, pending] = useActionState<SocialAdmissionFormState, FormData>(
    async (state, formData) => {
      const result = await socialAdmissionAction(orgSlug, state, formData)
      if (result.saved) {
        form.reset(form.getValues())
        toast.success("Sign-up settings updated")
      }
      return result
    },
    {}
  )
  const [domain, setDomain] = useState("")
  const [domainError, setDomainError] = useState<string>()
  const hasDefaultAccess = roleIds.length + teamIds.length > 0
  const hasProvider = googleEnabled || githubEnabled
  const googleInvalid =
    googleEnabled && (domains.length === 0 || !data.googleConfigured || domainError !== undefined)
  const googleError =
    domainError ??
    (validationVisible && googleInvalid
      ? !data.googleConfigured
        ? "Google sign-in is not configured for this deployment."
        : "Add at least one Google email domain."
      : undefined)
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
  useEffect(() => {
    if (!dirty) return
    const guard = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener("beforeunload", guard)
    return () => window.removeEventListener("beforeunload", guard)
  }, [dirty])

  function addDomain() {
    const value = domain.trim().toLowerCase()
    if (!socialAdmissionFormSchema.shape.googleDomains.element.safeParse(value).success) {
      setDomainError("Enter an exact email domain such as example.com.")
      return
    }
    setDomainError(undefined)
    if (domains.includes(value)) {
      setDomain("")
      return
    }
    form.setValue("googleDomains", [...domains, value], {
      shouldDirty: true,
      shouldValidate: validationVisible,
    })
    setDomain("")
  }

  const submit = form.handleSubmit((values) => {
    const formData = new FormData()
    if (values.enabled) formData.set("enabled", "on")
    if (values.googleEnabled) formData.set("google_enabled", "on")
    if (values.githubEnabled) formData.set("github_enabled", "on")
    for (const id of values.roleIds) formData.append("role_ids", id)
    for (const id of values.teamIds) formData.append("team_ids", id)
    for (const domain of values.googleDomains) formData.append("google_domains", domain)
    for (const organization of values.githubOrganizations)
      formData.append("github_organization", organization)
    for (const team of values.githubTeams) formData.append("github_team", team)
    startTransition(() => action(formData))
  })
  return (
    <form
      noValidate
      onSubmit={submit}
      className="flex max-w-4xl min-w-0 flex-col gap-8 px-4 pb-6 md:px-6"
    >
      <section className="flex flex-col gap-5">
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="social-admission-enabled">Enable Social Sign Up</FieldLabel>
            <FieldDescription>
              Allow people to join this Organization when their Google or GitHub account matches a
              rule below.
            </FieldDescription>
          </FieldContent>
          <Controller
            name="enabled"
            control={form.control}
            render={({ field }) => (
              <Switch
                ref={field.ref}
                onBlur={field.onBlur}
                aria-label="Enable Social Sign Up"
                checked={field.value}
                id="social-admission-enabled"
                onCheckedChange={(checked) => {
                  field.onChange(checked)
                  setDomainError(undefined)
                }}
              />
            )}
          />
        </Field>
        {state.error ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>Policy not saved</AlertTitle>
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        ) : null}
        {validationVisible && enabled && !hasDefaultAccess ? (
          <Alert variant="warning" role="alert">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>Default access required</AlertTitle>
            <AlertDescription>
              Select at least one default role or team before saving Social Sign Up.
            </AlertDescription>
          </Alert>
        ) : null}
        {validationVisible && enabled && !hasProvider ? (
          <Alert variant="warning" role="alert">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>Sign-in provider required</AlertTitle>
            <AlertDescription>Enable Google or GitHub before saving.</AlertDescription>
          </Alert>
        ) : null}
      </section>

      {enabled ? (
        <>
          <section className="flex flex-col gap-5">
            <div className="flex flex-col gap-1">
              <h3 className="flex items-center gap-2 text-base font-semibold">
                Default access <RequiredIndicator />
              </h3>
              <p className="text-sm text-muted-foreground">
                New members receive these roles and teams once, when they join.
              </p>
            </div>
            <FieldGroup
              className="grid md:grid-cols-2"
              data-invalid={validationVisible && !hasDefaultAccess}
            >
              <Field data-invalid={validationVisible && !hasDefaultAccess}>
                <FieldLabel htmlFor="default-roles">Default roles</FieldLabel>
                <Controller
                  name="roleIds"
                  control={form.control}
                  render={({ field }) => (
                    <MultiSelectDropdown
                      emptyMessage="No roles available."
                      id="default-roles"
                      invalid={validationVisible && !hasDefaultAccess}
                      ref={field.ref}
                      onBlurAction={field.onBlur}
                      onValueChangeAction={field.onChange}
                      aria-describedby="default-access-error"
                      options={data.roles.map((role) => ({
                        badge: role.workspace ?? role.scope,
                        badgeIcon: role.workspace ? PanelsTopLeft : undefined,
                        group: role.scope,
                        icon: Shield,
                        label: role.name,
                        value: role.id,
                      }))}
                      placeholder="Select default roles"
                      searchPlaceholder="Search roles..."
                      value={field.value}
                    />
                  )}
                />
              </Field>
              <Field data-invalid={validationVisible && !hasDefaultAccess}>
                <FieldLabel htmlFor="default-teams">Default teams</FieldLabel>
                <Controller
                  name="teamIds"
                  control={form.control}
                  render={({ field }) => (
                    <MultiSelectDropdown
                      emptyMessage="No teams available."
                      id="default-teams"
                      invalid={validationVisible && !hasDefaultAccess}
                      ref={field.ref}
                      onBlurAction={field.onBlur}
                      onValueChangeAction={field.onChange}
                      aria-describedby="default-access-error"
                      options={data.teams.map((team) => ({
                        icon: UsersRound,
                        label: team.name,
                        value: team.id,
                      }))}
                      placeholder="Select default teams"
                      searchPlaceholder="Search teams..."
                      value={field.value}
                    />
                  )}
                />
              </Field>
              {validationVisible && !hasDefaultAccess ? (
                <FieldError id="default-access-error" className="md:col-span-2">
                  Select at least one default role or team.
                </FieldError>
              ) : null}
            </FieldGroup>

            <div className="flex flex-col gap-3 pt-2">
              <div className="flex flex-col gap-1">
                <h4 className="text-sm font-medium">Qualified workspaces</h4>
                <p className="text-sm text-muted-foreground">
                  The selected default roles and teams grant access to these Workspaces.
                </p>
              </div>
              <div className="-mx-4 w-[100cqw] min-w-0 border-b md:-mx-6">
                <Table aria-label="Qualified workspaces">
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
                            <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
                              {workspace.sources.map((source) => (
                                <span key={`${source.kind}:${source.name}`}>
                                  <span className="font-medium text-foreground">{source.kind}</span>
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
                          className="h-24 text-center whitespace-normal text-muted-foreground"
                          colSpan={2}
                        >
                          <span className="text-muted-foreground">_</span>
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
              <p className="text-sm text-muted-foreground">
                Set the Google email domains and GitHub organizations or teams that may join.
              </p>
            </div>

            <div className="grid gap-8 @2xl:grid-cols-[21rem_minmax(0,1fr)]">
              <Controller
                name="googleEnabled"
                control={form.control}
                render={({ field }) => (
                  <ProviderHeading
                    ref={field.ref}
                    onBlur={field.onBlur}
                    checked={googleEnabled}
                    configured={data.googleConfigured}
                    description="Permit Google accounts with one of the listed email domains."
                    icon={<Google aria-hidden className="size-5" />}
                    id="google-enabled"
                    onCheckedChange={(checked) => {
                      field.onChange(checked)
                      setDomainError(undefined)
                    }}
                    title="Google"
                  />
                )}
              />
              {googleEnabled ? (
                <Field data-invalid={googleError !== undefined}>
                  <FieldLabel htmlFor="google-domains" required>
                    Email domains
                  </FieldLabel>
                  <InputGroup>
                    <InputGroupInput
                      aria-describedby={googleError ? "google-domains-error" : undefined}
                      aria-invalid={googleError !== undefined}
                      autoComplete="off"
                      id="google-domains"
                      aria-required={domains.length === 0}
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
                      <InputGroupButton onClick={addDomain} type="button">
                        <Plus data-icon="inline-start" />
                        Add
                      </InputGroupButton>
                    </InputGroupAddon>
                  </InputGroup>
                  {googleError ? (
                    <FieldError id="google-domains-error">{googleError}</FieldError>
                  ) : null}
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
                                form.setValue(
                                  "googleDomains",
                                  domains.filter((candidate) => candidate !== value),
                                  { shouldDirty: true, shouldValidate: validationVisible }
                                )
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
                  ) : !validationVisible ? (
                    <FieldDescription>No Google domains configured.</FieldDescription>
                  ) : null}
                </Field>
              ) : null}
            </div>

            <div className="grid gap-8 @2xl:grid-cols-[21rem_minmax(0,1fr)]">
              <Controller
                name="githubEnabled"
                control={form.control}
                render={({ field }) => (
                  <ProviderHeading
                    ref={field.ref}
                    onBlur={field.onBlur}
                    checked={githubEnabled}
                    configured={data.githubConfigured}
                    description="Permit members of a listed GitHub organization or team."
                    icon={
                      <>
                        <GitHubLight aria-hidden className="size-5 dark:hidden" />
                        <GitHubDark aria-hidden className="hidden size-5 dark:block" />
                      </>
                    }
                    id="github-enabled"
                    onCheckedChange={(checked) => {
                      field.onChange(checked)
                      setDomainError(undefined)
                    }}
                    title="GitHub"
                  />
                )}
              />
              {githubEnabled ? (
                <FieldGroup>
                  {rules.length ? (
                    rules.map((rule, index) => {
                      const organizationInvalid = Boolean(
                        form.formState.errors.githubOrganizations?.[index]
                      )
                      const teamInvalid = Boolean(form.formState.errors.githubTeams?.[index])
                      const errorId = `github-rule-${rule.id}-error`
                      return (
                        <Field
                          data-invalid={validationVisible && (organizationInvalid || teamInvalid)}
                          key={rule.id}
                        >
                          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
                            <Field>
                              <FieldLabel htmlFor={`github-organization-${rule.id}`} required>
                                Organization
                              </FieldLabel>
                              <Controller
                                name={`githubOrganizations.${index}`}
                                control={form.control}
                                render={({ field, fieldState }) => (
                                  <Input
                                    {...field}
                                    id={`github-organization-${rule.id}`}
                                    autoComplete="off"
                                    placeholder="acme"
                                    required
                                    aria-invalid={fieldState.invalid}
                                    aria-describedby={fieldState.invalid ? errorId : undefined}
                                  />
                                )}
                              />
                            </Field>
                            <Field>
                              <FieldLabel htmlFor={`github-team-${rule.id}`}>
                                Team slug <span className="text-muted-foreground">(optional)</span>
                              </FieldLabel>
                              <Controller
                                name={`githubTeams.${index}`}
                                control={form.control}
                                render={({ field, fieldState }) => (
                                  <Input
                                    {...field}
                                    id={`github-team-${rule.id}`}
                                    autoComplete="off"
                                    placeholder="platform"
                                    aria-invalid={fieldState.invalid}
                                    aria-describedby={fieldState.invalid ? errorId : undefined}
                                  />
                                )}
                              />
                            </Field>
                            <Button
                              aria-label={`Remove GitHub rule ${index + 1}`}
                              onClick={() => {
                                setRuleIds((current) =>
                                  current.filter((_, candidateIndex) => candidateIndex !== index)
                                )
                                form.setValue(
                                  "githubOrganizations",
                                  organizations.filter(
                                    (_, candidateIndex) => candidateIndex !== index
                                  ),
                                  { shouldDirty: true, shouldValidate: validationVisible }
                                )
                                form.setValue(
                                  "githubTeams",
                                  teams.filter((_, candidateIndex) => candidateIndex !== index),
                                  { shouldDirty: true, shouldValidate: validationVisible }
                                )
                              }}
                              size="icon"
                              type="button"
                              variant="ghost"
                            >
                              <X />
                            </Button>
                          </div>
                          {validationVisible && (organizationInvalid || teamInvalid) ? (
                            <FieldError id={errorId}>
                              {organizationInvalid
                                ? "Enter a valid GitHub organization name."
                                : "Enter a lowercase GitHub team slug."}
                            </FieldError>
                          ) : null}
                        </Field>
                      )
                    })
                  ) : validationVisible ? (
                    <FieldError>Add at least one GitHub rule.</FieldError>
                  ) : (
                    <FieldDescription>No GitHub rules configured.</FieldDescription>
                  )}
                  {validationVisible && !data.githubConfigured ? (
                    <FieldError>GitHub sign-in is not configured for this deployment.</FieldError>
                  ) : null}
                  <Button
                    className="w-fit"
                    onClick={() => {
                      const id = crypto.randomUUID()
                      setRuleIds((current) => [...current, id])
                      form.setValue("githubOrganizations", [...organizations, ""], {
                        shouldDirty: true,
                      })
                      form.setValue("githubTeams", [...teams, ""], { shouldDirty: true })
                    }}
                    type="button"
                    variant="outline"
                  >
                    <Plus data-icon="inline-start" />
                    Add GitHub rule
                  </Button>
                </FieldGroup>
              ) : null}
            </div>
          </section>

          <Alert variant="info">
            <Info aria-hidden="true" />
            <AlertTitle>Membership lifecycle</AlertTitle>
            <AlertDescription>
              We check these rules when a social account first joins this Organization. We assign
              the default access once and do not recalculate it on later sign-ins. Invitation links
              ignore these rules. The first signed-in User to accept a link receives the access
              configured on that Invitation.
            </AlertDescription>
          </Alert>

          <section className="flex flex-col gap-3">
            <h3 className="text-base font-semibold">Join link</h3>
            <div className="flex min-w-0 items-center gap-3 py-2">
              <code className="min-w-0 flex-1 truncate text-xs">{data.joinLink}</code>
              <CopyButton content={data.joinLink} />
            </div>
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
        <Button disabled={pending} type="submit">
          {pending ? <Spinner /> : <Save data-icon="inline-start" />}
          {pending ? "Saving..." : "Save admission policy"}
        </Button>
      </div>
    </form>
  )
}

function ProviderHeading({
  checked,
  configured,
  description,
  icon,
  id,
  onCheckedChange,
  title,
  ...switchProps
}: {
  checked: boolean
  configured: boolean
  description: string
  icon: React.ReactNode
  id: string
  onCheckedChange: (checked: boolean) => void
  title: string
} & Pick<ComponentProps<typeof Switch>, "ref" | "onBlur">) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-4">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
        {icon}
      </span>
      <div className="flex min-w-0 flex-col gap-1 pt-0.5">
        <label className="text-sm leading-5 font-medium" htmlFor={id}>
          {title}
        </label>
        <p className="text-sm leading-5 text-muted-foreground">
          {configured ? description : `${title} sign-in is not configured.`}
        </p>
      </div>
      <Switch
        {...switchProps}
        aria-label={`Enable ${title}`}
        checked={checked}
        className="mt-2 self-start"
        disabled={!configured && !checked}
        id={id}
        name={`${title.toLowerCase()}_enabled`}
        onCheckedChange={onCheckedChange}
      />
    </div>
  )
}
