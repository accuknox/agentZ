"use client"

import type { Route } from "next"
import * as React from "react"
import { useRouter } from "@bprogress/next/app"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  BotIcon,
  Download,
  Lock,
  MoreHorizontal,
  Pencil,
  ScrollText,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react"
import { useSearchParams } from "next/navigation"
import * as z from "zod"
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
import { watchAgentsQueryOptions } from "@/components/agent-readiness"
import {
  deleteAgentMutableSkills,
  deleteImmutableSkills,
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
export type Skill =
  | (MutableSkillSummary & { type: "mutable" })
  | (ImmutableSkillSummary & { type: "immutable" })
export type ImmutableSkill = ImmutableSkillSummary & { type: "immutable" }
type SkillKind = z.infer<typeof skillKindSchema>

type SkillListData = {
  skills: Skill[]
  nextPageToken: string
  hasNextPage: boolean
}

const emptySkills: Skill[] = []

export function SkillsClient({
  agents,
  initialAgentName,
  initialType,
}: {
  agents: Agent[]
  initialAgentName?: string
  initialType: SkillKind
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const queryClient = useQueryClient()
  const agentsQuery = useQuery(watchAgentsQueryOptions(agents))
  const liveAgents = agentsQuery.data ?? agents
  const firstAgentName = liveAgents[0]?.name ?? ""
  const initialAgentExists = liveAgents.some((agent) => agent.name === initialAgentName)
  const startType = initialType
  const startAgentName =
    startType === "immutable"
      ? initialAgentExists && initialAgentName
        ? initialAgentName
        : allAgentsValue
      : initialAgentExists && initialAgentName
        ? initialAgentName
        : firstAgentName
  const [type, setType] = React.useState<SkillKind>(startType)
  const [agentName, setAgentName] = React.useState(startAgentName)
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set())
  const [error, setError] = React.useState<string>()
  const [deleteNames, setDeleteNames] = React.useState<string[]>([])
  const [editingSkill, setEditingSkill] = React.useState<ImmutableSkill>()
  const [importOpen, setImportOpen] = React.useState(false)
  const [exporting, setExporting] = React.useState(false)
  const routeType = searchParams.has("type")
    ? skillKindSchema.parse(searchParams.get("type"))
    : startType
  const routeAgentName = searchParams.get("agent_name") ?? ""
  const pageToken =
    routeType === type && (routeAgentName === "" || routeAgentName === agentName)
      ? (searchParams.get("page_token") ?? "")
      : ""

  const selectedAgent = liveAgents.find((agent) => agent.name === agentName)
  const mutableReady = type === "immutable" || selectedAgent?.status === "IDLE"
  const mutableOptions = listAgentMutableSkillsOptions({
    path: { agentName },
    query: { limit: pageSize, page_token: pageToken || undefined },
  })
  const immutableOptions = listImmutableSkillSummariesOptions({
    query: {
      agent_name: agentName === allAgentsValue ? undefined : agentName,
      limit: pageSize,
      page_token: pageToken || undefined,
    },
  })
  const mutableQuery = useQuery({
    ...mutableOptions,
    enabled: type === "mutable" && agentName.length > 0 && mutableReady,
    select: (result): SkillListData => ({
      skills: result.skills.map((skill) => ({ ...skill, type: "mutable" })),
      nextPageToken: result.next_page_token,
      hasNextPage: result.next_page_token.length > 0,
    }),
  })
  const immutableQuery = useQuery({
    ...immutableOptions,
    enabled: type === "immutable",
    select: (result): SkillListData => ({
      skills: result.skills.map((skill) => ({ ...skill, type: "immutable" })),
      nextPageToken: result.next_page_token,
      hasNextPage: result.next_page_token.length > 0,
    }),
  })
  const query = type === "mutable" ? mutableQuery : immutableQuery
  const queryKey = type === "mutable" ? mutableOptions.queryKey : immutableOptions.queryKey
  const skills = query.data?.skills ?? emptySkills
  const skillsByName = React.useMemo(
    () => new Map(skills.map((skill) => [skill.name, skill])),
    [skills]
  )
  const deleteTargets = deleteNames.flatMap((name) => {
    const skill = skillsByName.get(name)
    return skill ? [skill] : []
  })

  function routeFor(nextType: SkillKind, nextAgentName: string, nextPageToken = ""): Route {
    const params = new URLSearchParams({ type: nextType })
    if (nextAgentName && (nextType === "mutable" || nextAgentName !== allAgentsValue)) {
      params.set("agent_name", nextAgentName)
    }
    if (nextPageToken) {
      params.set("page_token", nextPageToken)
    }
    return `/skills?${params}` as Route
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

  async function exportSkills(skillNames: string[]) {
    if (skillNames.length === 0 || exporting) {
      return
    }
    setError(undefined)
    setExporting(true)
    try {
      const result =
        type === "mutable"
          ? await exportAgentMutableSkills({
              path: { agentName },
              body: { skill_names: skillNames },
            })
          : await exportImmutableSkills({ body: { skill_names: skillNames } })
      if (result.error) {
        setError(result.error.message)
        toast.error(skillNames.length === 1 ? "Failed to export skill" : "Failed to export skills")
        return
      }

      let filename = "skills.zip"
      if (type === "mutable") {
        filename =
          skillNames.length === 1 ? `${agentName}-${skillNames[0]}.zip` : `${agentName}-skills.zip`
      }
      const href = URL.createObjectURL(result.data)
      const link = document.createElement("a")
      link.href = href
      link.download = filename
      link.click()
      URL.revokeObjectURL(href)
      toast.success(skillNames.length === 1 ? "Skill exported" : "Skills exported")
    } finally {
      setExporting(false)
    }
  }

  async function deleteSelected() {
    if (deleteNames.length === 0) {
      return
    }
    setError(undefined)

    const namesToDelete = deleteNames
    setDeleteNames([])
    setSelected(new Set())

    const result =
      type === "mutable"
        ? await deleteAgentMutableSkills({
            path: { agentName },
            body: { skill_names: namesToDelete },
          })
        : await deleteImmutableSkills({ body: { skill_names: namesToDelete } })
    if (result.error) {
      setError(result.error.message)
      toast.error(namesToDelete.length === 1 ? "Failed to delete skill" : "Failed to delete skills")
      await refreshSkills()
      return
    }
    toast.success(namesToDelete.length === 1 ? "Skill deleted" : "Skills deleted")
    await refreshSkills()
  }

  const canUseMutableSkills = mutableReady && (type === "immutable" || agentName.length > 0)
  const showAgentFilter = type === "immutable" || liveAgents.length > 0

  return (
    <>
      <div className="flex flex-col gap-3 px-4 pt-4 sm:flex-row sm:items-start sm:justify-between md:px-6 md:pt-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal">Skills</h1>
        </div>
        <SkillsActions
          disabled={!canUseMutableSkills}
          exporting={exporting}
          selectedCount={selected.size}
          onDelete={() => setDeleteNames([...selected])}
          onExport={() => void exportSkills([...selected])}
          onImport={() => setImportOpen(true)}
        />
      </div>
      <div className="bg-background flex min-h-14 flex-col gap-3 border-b px-4 py-2 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="grid w-full gap-2 sm:flex sm:w-auto sm:items-center">
          <Select value={type} onValueChange={(value) => chooseType(skillKindSchema.parse(value))}>
            <SelectTrigger className="h-8 w-full min-w-0 rounded-md sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="mutable">
                  <Pencil className="inline-block" />
                  Mutable
                </SelectItem>
                <SelectItem value="immutable">
                  <Lock className="inline-block" />
                  Immutable
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
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
        disabled={!mutableReady}
        error={query.error}
        exporting={exporting}
        hasNextPage={query.data?.hasNextPage ?? false}
        loading={query.isPending}
        nextPageToken={query.data?.nextPageToken ?? ""}
        selected={selected}
        showAgents={type === "immutable" && agentName === allAgentsValue}
        showImmutable={type === "immutable"}
        setDeleteNames={setDeleteNames}
        setSelected={setSelected}
        onEdit={setEditingSkill}
        onExport={(name) => void exportSkills([name])}
      />
      <SkillImportDialog
        agents={liveAgents}
        open={importOpen}
        setOpen={setImportOpen}
        onImported={refreshSkills}
      />
      <EditSkillDialog
        key={editingSkill ? `${editingSkill.name}:${editingSkill.version}` : "edit-skill"}
        skill={editingSkill}
        open={Boolean(editingSkill)}
        setOpen={(open) => {
          if (!open) {
            setEditingSkill(undefined)
          }
        }}
        onUpdated={refreshSkills}
      />
      <DeleteDialog
        names={deleteNames}
        open={deleteNames.length > 0}
        targets={deleteTargets}
        setOpen={(open) => {
          if (!open) {
            setDeleteNames([])
          }
        }}
        onDelete={deleteSelected}
      />
    </>
  )
}

function SkillsActions({
  disabled,
  exporting,
  selectedCount,
  onDelete,
  onExport,
  onImport,
}: {
  disabled: boolean
  exporting: boolean
  selectedCount: number
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
            onSelect={(event) => {
              event.preventDefault()
              onImport()
            }}
          >
            <Upload />
            Import
          </DropdownMenuItem>
          <DropdownMenuItem disabled={selectedCount === 0 || exporting} onSelect={onExport}>
            {exporting ? <Spinner /> : <Download />}
            Export
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive"
            disabled={selectedCount === 0}
            onSelect={onDelete}
          >
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
}: {
  skill?: ImmutableSkill
  open: boolean
  setOpen: (open: boolean) => void
  onUpdated: () => Promise<void>
}) {
  const [error, setError] = React.useState<{ skillName: string; message: string }>()
  const [pending, startTransition] = React.useTransition()
  const [version, setVersion] = React.useState(String(skill?.version ?? ""))
  const versionsQuery = useQuery({
    ...listImmutableSkillVersionsOptions({ path: { skillName: skill?.name ?? "" } }),
    enabled: open && Boolean(skill?.name),
  })
  const versionValues = new Set(versionsQuery.data ?? [])
  if (skill) {
    versionValues.add(skill.version)
  }
  const versions = [...versionValues].toSorted((a, b) => a - b)
  const errorMessage = error && error.skillName === skill?.name ? error.message : undefined

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!skill) {
      return
    }
    const nextVersion = Number(version)
    if (!versions.includes(nextVersion)) {
      setError({ skillName: skill.name, message: "Version is unavailable" })
      return
    }

    startTransition(async () => {
      setError(undefined)
      const result = await updateSkill({
        path: { skillName: skill.name },
        body: { version: nextVersion },
      })
      if (result.error) {
        setError({ skillName: skill.name, message: result.error.message })
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
                value={version}
                disabled={pending || versionsQuery.isPending}
                onValueChange={(value) => {
                  setError(undefined)
                  setVersion(value)
                }}
              >
                <SelectTrigger id="skill-edit-version" aria-invalid={Boolean(errorMessage)}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {versions.map((item) => (
                      <SelectItem key={item} value={String(item)}>
                        v{item}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
          {(errorMessage ?? versionsQuery.error?.message) ? (
            <p className="text-destructive text-sm">
              {errorMessage ?? versionsQuery.error?.message}
            </p>
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
  names,
  open,
  targets,
  setOpen,
  onDelete,
}: {
  names: string[]
  open: boolean
  targets: Skill[]
  setOpen: (open: boolean) => void
  onDelete: () => Promise<void>
}) {
  const [pending, startTransition] = React.useTransition()
  const immutableTargets = targets.filter(
    (skill): skill is ImmutableSkill => skill.type === "immutable"
  )
  const agentRefs = new Set(immutableTargets.flatMap((skill) => skill.agents))
  const sandboxRefs = new Set(immutableTargets.flatMap((skill) => skill.sandboxes))
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
