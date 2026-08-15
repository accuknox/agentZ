"use client"

import * as React from "react"
import { useRouter } from "@bprogress/next/app"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  BotIcon,
  Download,
  History,
  Lock,
  MoreHorizontal,
  Pencil,
  ScrollText,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react"
import { usePathname, useSearchParams } from "next/navigation"
import * as z from "zod"
import { watchAgentsQueryOptions } from "@/components/agent-readiness"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import {
  deleteImmutableSkills,
  deleteAgentMutableSkills,
  exportAgentMutableSkills,
  exportImmutableSkills,
  updateSkill,
  type Agent,
  type ImmutableSkillSummary,
  type MutableSkillSummary,
} from "@/lib/gateway/client"
import {
  listAgentMutableSkillsOptions,
  listImmutableSkillSummariesOptions,
  listImmutableSkillVersionsOptions,
} from "@/lib/gateway/client/@tanstack/react-query.gen"
import { SkillImportDialog } from "./skill-import-dialog"
import { SkillTable } from "./skill-table"

const pageSize = 50
const allAgentsValue = "__all_agents__"
const skillKindSchema = z.enum(["mutable", "immutable"])

type SkillKind = z.infer<typeof skillKindSchema>
export type MutableSkill = MutableSkillSummary & { key: string; type: "mutable" }
export type ImmutableSkill = ImmutableSkillSummary & { key: string; type: "immutable" }
export type Skill = MutableSkill | ImmutableSkill

type SkillListData = {
  skills: Skill[]
  nextPageToken: string
  hasNextPage: boolean
}

const emptySkills: Skill[] = []

export function SkillsClient({
  agents,
  canCreateImmutable,
  canReadImmutable,
  workspaceId,
}: {
  agents: Agent[]
  canCreateImmutable: boolean
  canReadImmutable: boolean
  workspaceId?: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const queryClient = useQueryClient()
  const agentsQuery = useQuery({
    ...watchAgentsQueryOptions(workspaceId ?? "", agents),
    enabled: workspaceId !== undefined,
  })
  const liveAgents = agentsQuery.data ?? agents
  const firstAgentName = liveAgents[0]?.name ?? ""
  const canUseMutable = workspaceId !== undefined && liveAgents.length > 0
  const requestedKind = skillKindSchema.safeParse(searchParams.get("type"))
  let startType: SkillKind = canUseMutable ? "mutable" : "immutable"
  if (requestedKind.success) {
    const allowed = requestedKind.data === "mutable" ? canUseMutable : canReadImmutable
    if (allowed) {
      startType = requestedKind.data
    }
  }
  const requestedAgent = liveAgents.find(
    (agent) => agent.name === searchParams.get("agent_name")
  )?.name
  const startAgentName =
    requestedAgent ?? (startType === "immutable" ? allAgentsValue : firstAgentName)
  const [type, setType] = React.useState<SkillKind>(startType)
  const [agentName, setAgentName] = React.useState(startAgentName)
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set())
  const [error, setError] = React.useState<string>()
  const [deleteKeys, setDeleteKeys] = React.useState<string[]>([])
  const [editingSkill, setEditingSkill] = React.useState<ImmutableSkill>()
  const [importOpen, setImportOpen] = React.useState(false)
  const [exporting, setExporting] = React.useState(false)
  const scopeHeaders = workspaceId ? { "X-AgentZ-Workspace-ID": workspaceId } : undefined
  const routeType = requestedKind.success ? requestedKind.data : startType
  const routeAgentName = searchParams.get("agent_name") ?? ""
  const pageToken =
    routeType === type && (routeAgentName === "" || routeAgentName === agentName)
      ? (searchParams.get("page_token") ?? "")
      : ""
  const selectedAgent = liveAgents.find((agent) => agent.name === agentName)
  const ready = type === "immutable" || selectedAgent?.status === "IDLE"
  const mutableOptions = listAgentMutableSkillsOptions({
    headers: scopeHeaders,
    path: { agentName },
    query: { limit: pageSize, page_token: pageToken || undefined },
  })
  const immutableOptions = listImmutableSkillSummariesOptions({
    headers: scopeHeaders,
    query: {
      agent_name: agentName === allAgentsValue ? undefined : agentName,
      limit: pageSize,
      page_token: pageToken || undefined,
    },
  })
  const mutableQuery = useQuery({
    ...mutableOptions,
    enabled: type === "mutable" && agentName.length > 0 && ready,
    select: (result): SkillListData => ({
      skills: result.skills.map((skill) => ({
        ...skill,
        key: skill.name,
        type: "mutable",
      })),
      nextPageToken: result.next_page_token,
      hasNextPage: result.next_page_token.length > 0,
    }),
  })
  const immutableQuery = useQuery({
    ...immutableOptions,
    enabled: type === "immutable" && canReadImmutable,
    select: (result): SkillListData => ({
      skills: result.skills.map((skill) => ({
        ...skill,
        key: `${skill.scope}/${skill.name}`,
        type: "immutable",
      })),
      nextPageToken: result.next_page_token,
      hasNextPage: result.next_page_token.length > 0,
    }),
  })
  const query = type === "mutable" ? mutableQuery : immutableQuery
  const queryKey = type === "mutable" ? mutableOptions.queryKey : immutableOptions.queryKey
  const skills = query.data?.skills ?? emptySkills
  const skillsByKey = React.useMemo(
    () => new Map(skills.map((skill) => [skill.key, skill])),
    [skills]
  )
  const activeSelected = React.useMemo(
    () => new Set([...selected].filter((key) => skillsByKey.has(key))),
    [selected, skillsByKey]
  )
  const deleteTargets = deleteKeys.flatMap((key) => {
    const skill = skillsByKey.get(key)
    return skill ? [skill] : []
  })
  const canDeleteSelected =
    activeSelected.size > 0 &&
    [...activeSelected].every((key) => {
      const skill = skillsByKey.get(key)
      return skill?.type === "mutable" || skill?.can_delete === true
    })

  function routeFor(nextType: SkillKind, nextAgentName: string) {
    const params = new URLSearchParams(searchParams)
    params.set("type", nextType)
    if (nextAgentName && (nextType === "mutable" || nextAgentName !== allAgentsValue)) {
      params.set("agent_name", nextAgentName)
    } else {
      params.delete("agent_name")
    }
    params.delete("page_token")
    params.delete("token_stack")
    return `${pathname}?${params}`
  }

  function chooseType(nextType: SkillKind) {
    const nextAgentName =
      nextType === "immutable"
        ? agentName || allAgentsValue
        : agentName && agentName !== allAgentsValue
          ? agentName
          : firstAgentName
    setSelected(new Set())
    setType(nextType)
    setAgentName(nextAgentName)
    router.replace(routeFor(nextType, nextAgentName))
  }

  function chooseAgent(nextAgentName: string) {
    setSelected(new Set())
    setAgentName(nextAgentName)
    router.replace(routeFor(type, nextAgentName))
  }

  async function refreshSkills() {
    await queryClient.invalidateQueries({ queryKey })
  }

  async function exportSkills(keys: string[]) {
    const targets = keys.flatMap((key) => {
      const skill = skillsByKey.get(key)
      return skill ? [skill] : []
    })
    const first = targets[0]
    if (!first || exporting) {
      return
    }
    const request =
      type === "mutable"
        ? selectedAgent
          ? exportAgentMutableSkills({
              body: { skill_names: targets.map((skill) => skill.name) },
              headers: scopeHeaders,
              path: { agentName: selectedAgent.name },
            })
          : undefined
        : exportImmutableSkills({
            body: {
              skills: targets.flatMap((skill) =>
                skill.type === "immutable" ? [{ name: skill.name, scope: skill.scope }] : []
              ),
            },
            headers: scopeHeaders,
          })
    if (!request) return
    setError(undefined)
    setExporting(true)
    try {
      const result = await request
      if (result.error) {
        setError(result.error.message)
        toast.error(targets.length === 1 ? "Failed to export skill" : "Failed to export skills")
        return
      }

      let filename = "skills.zip"
      if (type === "mutable" && selectedAgent) {
        filename =
          targets.length === 1
            ? `${selectedAgent.name}-${first.name}.zip`
            : `${selectedAgent.name}-skills.zip`
      }
      const href = URL.createObjectURL(result.data)
      const link = document.createElement("a")
      link.href = href
      link.download = filename
      link.click()
      URL.revokeObjectURL(href)
      toast.success(targets.length === 1 ? "Skill exported" : "Skills exported")
    } finally {
      setExporting(false)
    }
  }

  async function deleteSelected() {
    if (deleteTargets.length === 0) {
      return
    }
    setError(undefined)

    const namesToDelete = deleteTargets.map((skill) => skill.name)
    const request =
      type === "mutable"
        ? selectedAgent
          ? deleteAgentMutableSkills({
              body: { skill_names: namesToDelete },
              headers: scopeHeaders,
              path: { agentName: selectedAgent.name },
            })
          : undefined
        : deleteImmutableSkills({
            body: { skill_names: namesToDelete },
            headers: scopeHeaders,
          })
    if (!request) return
    setDeleteKeys([])
    setSelected(new Set())

    const result = await request
    if (result.error) {
      setError(result.error.message)
      toast.error(namesToDelete.length === 1 ? "Failed to delete skill" : "Failed to delete skills")
      await refreshSkills()
      return
    }
    toast.success(namesToDelete.length === 1 ? "Skill deleted" : "Skills deleted")
    await refreshSkills()
  }

  const actionsEnabled = ready && (type === "immutable" || agentName.length > 0)
  const canImport = type === "mutable" ? ready : canCreateImmutable
  const showAgentFilter = type === "immutable" || liveAgents.length > 0

  return (
    <>
      <div className="flex flex-col gap-3 px-4 pt-4 sm:flex-row sm:items-start sm:justify-between md:px-6 md:pt-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal">Skills</h1>
        </div>
        <SkillsActions
          canDelete={canDeleteSelected}
          canImport={canImport}
          disabled={!actionsEnabled}
          exporting={exporting}
          hasSelection={activeSelected.size > 0}
          onDelete={() => setDeleteKeys([...activeSelected])}
          onExport={() => void exportSkills([...activeSelected])}
          onImport={() => setImportOpen(true)}
        />
      </div>
      <div className="bg-background flex min-h-14 flex-col gap-3 border-b px-4 py-2 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="grid w-full gap-2 sm:flex sm:w-auto sm:items-center">
          {workspaceId ? (
            <Select
              value={type}
              onValueChange={(value) => chooseType(skillKindSchema.parse(value))}
            >
              <SelectTrigger className="h-8 w-full min-w-0 rounded-md sm:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {canUseMutable ? (
                    <SelectItem value="mutable">
                      <Pencil className="inline-block" />
                      Mutable
                    </SelectItem>
                  ) : null}
                  {canReadImmutable ? (
                    <SelectItem value="immutable">
                      <Lock className="inline-block" />
                      Immutable
                    </SelectItem>
                  ) : null}
                </SelectGroup>
              </SelectContent>
            </Select>
          ) : null}
          {showAgentFilter ? (
            <Select value={agentName} onValueChange={chooseAgent}>
              <SelectTrigger className="h-8 w-full min-w-0 rounded-md sm:w-64 sm:min-w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {type === "immutable" ? (
                    <SelectItem value={allAgentsValue}>
                      <ScrollText className="inline-block" />
                      All
                    </SelectItem>
                  ) : null}
                  {liveAgents.map((agent) => (
                    <SelectItem key={agent.name} value={agent.name}>
                      <BotIcon className="inline-block" />
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          ) : null}
        </div>
      </div>
      {error ? (
        <div className="border-destructive/30 bg-destructive/5 text-destructive mx-4 mt-4 mb-4 rounded-lg border px-4 py-3 text-sm md:mx-6">
          {error}
        </div>
      ) : null}
      <SkillTable
        data={skills}
        disabled={!ready}
        error={query.error}
        exporting={exporting}
        hasNextPage={query.data?.hasNextPage ?? false}
        loading={query.isPending}
        nextPageToken={query.data?.nextPageToken ?? ""}
        selected={activeSelected}
        showAgents={type === "immutable" && agentName === allAgentsValue}
        showImmutable={type === "immutable"}
        setSelected={setSelected}
        onDelete={(key) => setDeleteKeys([key])}
        onEdit={setEditingSkill}
        onExport={(key) => void exportSkills([key])}
      />
      <SkillImportDialog
        agents={liveAgents}
        canImportImmutable={canCreateImmutable && canReadImmutable}
        open={importOpen}
        setOpen={setImportOpen}
        onImported={refreshSkills}
        workspaceId={workspaceId}
      />
      <EditSkillDialog
        key={editingSkill ? `${editingSkill.name}:${editingSkill.version}` : "edit-skill"}
        skill={editingSkill}
        open={editingSkill !== undefined}
        setOpen={(open) => {
          if (!open) {
            setEditingSkill(undefined)
          }
        }}
        onUpdated={refreshSkills}
        workspaceId={workspaceId}
      />
      <DeleteDialog
        open={deleteKeys.length > 0}
        targets={deleteTargets}
        setOpen={(open) => {
          if (!open) {
            setDeleteKeys([])
          }
        }}
        onDelete={deleteSelected}
      />
    </>
  )
}

function SkillsActions({
  canDelete,
  canImport,
  disabled,
  exporting,
  hasSelection,
  onDelete,
  onExport,
  onImport,
}: {
  canDelete: boolean
  canImport: boolean
  disabled: boolean
  exporting: boolean
  hasSelection: boolean
  onDelete: () => void
  onExport: () => void
  onImport: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" disabled={disabled}>
          <span className="sr-only">Open skills menu</span>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuItem
            disabled={!canImport}
            onSelect={(event) => {
              event.preventDefault()
              onImport()
            }}
          >
            <Upload />
            Import
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasSelection || exporting} onSelect={onExport}>
            {exporting ? <Spinner /> : <Download />}
            Export
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" disabled={!canDelete} onSelect={onDelete}>
            <Trash2 />
            Delete
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function EditSkillDialog({
  skill,
  open,
  setOpen,
  onUpdated,
  workspaceId,
}: {
  skill?: ImmutableSkill
  open: boolean
  setOpen: (open: boolean) => void
  onUpdated: () => Promise<void>
  workspaceId?: string
}) {
  const [error, setError] = React.useState<string>()
  const [pending, startTransition] = React.useTransition()
  const [version, setVersion] = React.useState(skill?.version)
  const scopeHeaders = workspaceId ? { "X-AgentZ-Workspace-ID": workspaceId } : undefined
  const versionsQuery = useQuery({
    ...listImmutableSkillVersionsOptions({
      headers: scopeHeaders,
      path: { skillName: skill?.name ?? "" },
      query: { scope: workspaceId ? "Workspace" : "Organisation" },
    }),
    enabled: open && skill !== undefined,
  })
  const versionValues = new Set(versionsQuery.data ?? [])
  if (skill) {
    versionValues.add(skill.version)
  }
  const versions = [...versionValues].toSorted((a, b) => a - b)
  const versionsByValue = new Map(versions.map((item) => [String(item), item]))

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!skill) {
      return
    }
    if (version === undefined || !versions.includes(version)) {
      setError("Version is unavailable")
      return
    }

    startTransition(async () => {
      setError(undefined)
      const result = await updateSkill({
        headers: scopeHeaders,
        path: { skillName: skill.name },
        body: { version },
      })
      if (result.error) {
        setError(result.error.message)
        toast.error("Failed to update skill version")
        return
      }
      toast.success("Skill version updated")
      setOpen(false)
      await onUpdated()
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{skill ? `Change version for ${skill.name}` : "Change version"}</DialogTitle>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="skill-edit-version" required>
                Version
              </FieldLabel>
              <Select
                value={version === undefined ? "" : String(version)}
                disabled={pending || versionsQuery.isPending}
                onValueChange={(value) => {
                  setError(undefined)
                  setVersion(versionsByValue.get(value))
                }}
              >
                <SelectTrigger id="skill-edit-version" aria-invalid={error !== undefined}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {versions.map((item) => (
                      <SelectItem key={item} value={String(item)}>
                        <History />v{item}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
          {(error ?? versionsQuery.error?.message) ? (
            <p className="text-destructive text-sm">{error ?? versionsQuery.error?.message}</p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending || versions.length === 0}>
              {pending ? <Spinner /> : <Pencil />}
              Update
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DeleteDialog({
  open,
  targets,
  setOpen,
  onDelete,
}: {
  open: boolean
  targets: Skill[]
  setOpen: (open: boolean) => void
  onDelete: () => Promise<void>
}) {
  const [pending, startTransition] = React.useTransition()
  const names = targets.map((skill) => skill.name)
  const immutable = targets.filter((skill) => skill.type === "immutable")
  const agentRefs = new Set(immutable.flatMap((skill) => skill.agents))
  const sandboxRefs = new Set(immutable.flatMap((skill) => skill.sandboxes))
  const hasRefs = agentRefs.size > 0 || sandboxRefs.size > 0
  const title = names.length === 1 ? `Delete ${names[0]}?` : `Delete ${names.length} skills?`

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>This will remove the skill permanently.</DialogDescription>
        </DialogHeader>
        {hasRefs ? (
          <Alert variant="warning">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <AlertDescription>
              Referenced by {agentRefs.size} agent{agentRefs.size === 1 ? "" : "s"} and{" "}
              {sandboxRefs.size} sandbox{sandboxRefs.size === 1 ? "" : "es"}. Deletion detaches
              those references and removes every stored version.
            </AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => {
              startTransition(async () => {
                await onDelete()
              })
            }}
          >
            {pending ? <Spinner /> : <Trash2 />}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
