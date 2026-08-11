"use client"

import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { ChevronDown, Download, Pencil, Trash2, TriangleAlert, Upload } from "lucide-react"
import { useSearchParams } from "next/navigation"
import { AdministrationPageHeader } from "@/components/administration"
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
  exportImmutableSkills,
  updateSkill,
  type ImmutableSkillSummary,
} from "@/lib/gateway/client"
import {
  listImmutableSkillSummariesOptions,
  listImmutableSkillVersionsOptions,
} from "@/lib/gateway/client/@tanstack/react-query.gen"
import { SkillImportDialog } from "./skill-import-dialog"
import { SkillTable } from "./skill-table"

const pageSize = 50
export type ImmutableSkill = ImmutableSkillSummary
export type Skill = ImmutableSkill

type SkillListData = {
  skills: Skill[]
  nextPageToken: string
  hasNextPage: boolean
}

const emptySkills: Skill[] = []

export function SkillsClient({
  canCreate,
  workspaceId,
}: {
  canCreate: boolean
  workspaceId?: string
}) {
  const searchParams = useSearchParams()
  const queryClient = useQueryClient()
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set())
  const [error, setError] = React.useState<string>()
  const [deleteNames, setDeleteNames] = React.useState<string[]>([])
  const [editingSkill, setEditingSkill] = React.useState<ImmutableSkill>()
  const [importOpen, setImportOpen] = React.useState(false)
  const [exporting, setExporting] = React.useState(false)
  const scopeHeaders = workspaceId ? { "X-AgentZ-Workspace-ID": workspaceId } : undefined
  const pageToken = searchParams.get("page_token") ?? ""
  const immutableOptions = listImmutableSkillSummariesOptions({
    headers: scopeHeaders,
    query: {
      limit: pageSize,
      page_token: pageToken || undefined,
    },
  })
  const query = useQuery({
    ...immutableOptions,
    select: (result): SkillListData => ({
      skills: result.skills,
      nextPageToken: result.next_page_token,
      hasNextPage: result.next_page_token.length > 0,
    }),
  })
  const queryKey = immutableOptions.queryKey
  const skills = query.data?.skills ?? emptySkills
  const skillsByName = React.useMemo(
    () => new Map(skills.map((skill) => [skill.name, skill])),
    [skills]
  )
  const deleteTargets = deleteNames.flatMap((name) => {
    const skill = skillsByName.get(name)
    return skill ? [skill] : []
  })
  const canDeleteSelected =
    selected.size > 0 &&
    [...selected].every((name) => {
      const skill = skillsByName.get(name)
      return Boolean(skill?.can_delete)
    })

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
      const result = await exportImmutableSkills({
        body: {
          skills: skillNames.map((name) => ({
            name,
            scope: workspaceId ? "Workspace" : "Organisation",
          })),
        },
        headers: scopeHeaders,
      })
      if (result.error) {
        setError(result.error.message)
        toast.error(skillNames.length === 1 ? "Failed to export skill" : "Failed to export skills")
        return
      }

      const filename = skillNames.length === 1 ? `${skillNames[0]}.zip` : "skills.zip"
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

    const result = await deleteImmutableSkills({
      body: { skill_names: namesToDelete },
      headers: scopeHeaders,
    })
    if (result.error) {
      setError(result.error.message)
      toast.error(namesToDelete.length === 1 ? "Failed to delete skill" : "Failed to delete skills")
      await refreshSkills()
      return
    }
    toast.success(namesToDelete.length === 1 ? "Skill deleted" : "Skills deleted")
    await refreshSkills()
  }

  return (
    <>
      <div className="flex min-w-0 flex-col gap-6">
        <AdministrationPageHeader
          actions={
            canCreate || selected.size > 0 ? (
              <SkillsActions
                canCreate={canCreate}
                canDelete={canDeleteSelected}
                exporting={exporting}
                selectedCount={selected.size}
                onDelete={() => setDeleteNames([...selected])}
                onExport={() => void exportSkills([...selected])}
                onImport={() => setImportOpen(true)}
              />
            ) : undefined
          }
          title="Skills"
        />
        {error ? (
          <div className="border-destructive/30 bg-destructive/5 text-destructive mx-4 rounded-lg border px-4 py-3 text-sm md:mx-6">
            {error}
          </div>
        ) : null}
        <SkillTable
          data={skills}
          error={query.error}
          exporting={exporting}
          hasNextPage={query.data?.hasNextPage ?? false}
          loading={query.isPending}
          nextPageToken={query.data?.nextPageToken ?? ""}
          selected={selected}
          setDeleteNames={setDeleteNames}
          setSelected={setSelected}
          onEdit={setEditingSkill}
          onExport={(name) => void exportSkills([name])}
        />
      </div>
      <SkillImportDialog
        open={importOpen}
        setOpen={setImportOpen}
        onImported={refreshSkills}
        workspaceId={workspaceId}
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
        workspaceId={workspaceId}
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
  canCreate,
  canDelete,
  exporting,
  selectedCount,
  onDelete,
  onExport,
  onImport,
}: {
  canCreate: boolean
  canDelete: boolean
  exporting: boolean
  selectedCount: number
  onDelete: () => void
  onExport: () => void
  onImport: () => void
}) {
  return (
    <div className="flex items-center gap-2">
      {selectedCount > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">
              {selectedCount} selected
              <ChevronDown data-icon="inline-end" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuItem disabled={exporting} onSelect={onExport}>
                {exporting ? <Spinner /> : <Download />}
                Export
              </DropdownMenuItem>
              {canDelete ? (
                <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                  <Trash2 />
                  Delete
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {canCreate ? (
        <Button onClick={onImport}>
          <Upload data-icon="inline-start" />
          Import skill
        </Button>
      ) : null}
    </div>
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
  const [error, setError] = React.useState<{ skillName: string; message: string }>()
  const [pending, startTransition] = React.useTransition()
  const [version, setVersion] = React.useState(String(skill?.version ?? ""))
  const versionsQuery = useQuery({
    ...listImmutableSkillVersionsOptions({
      headers: workspaceId ? { "X-AgentZ-Workspace-ID": workspaceId } : undefined,
      path: { skillName: skill?.name ?? "" },
      query: { scope: workspaceId ? "Workspace" : "Organisation" },
    }),
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
        headers: workspaceId ? { "X-AgentZ-Workspace-ID": workspaceId } : undefined,
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
  const agentRefs = new Set(targets.flatMap((skill) => skill.agents))
  const sandboxRefs = new Set(targets.flatMap((skill) => skill.sandboxes))
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
