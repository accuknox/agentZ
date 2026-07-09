"use client"

import type { Route } from "next"
import * as React from "react"
import { useRouter } from "@bprogress/next/app"
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query"
import { Download, MoreHorizontal, Trash2, Upload } from "lucide-react"
import { useSearchParams } from "next/navigation"
import * as z from "zod"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import type { Agent } from "@/lib/gateway/client"
import { SkillImportDialog } from "./skill-import-dialog"
import { SkillTable } from "./skill-table"

const pageSize = 50

const skillSchema = z.object({
  name: z.string(),
  fileCount: z.number(),
  sizeBytes: z.number(),
  modifiedAt: z.string().nullable(),
})

const listResponseSchema = z.object({
  skills: z.array(skillSchema),
  nextPageToken: z.string(),
  hasNextPage: z.boolean(),
})

const apiErrorSchema = z.object({
  error: z.string(),
})

export type Skill = z.infer<typeof skillSchema>

function skillsQueryOptions(agentName: string, pageToken: string) {
  return queryOptions({
    queryKey: ["skills", agentName, pageToken],
    enabled: agentName.length > 0,
    queryFn: async () => {
      const params = new URLSearchParams({
        agent_name: agentName,
        limit: String(pageSize),
      })
      if (pageToken) {
        params.set("page_token", pageToken)
      }
      const response = await fetch(`/api/skills/list?${params}`)
      const data = await response.json()
      if (!response.ok) {
        throw new Error(apiErrorSchema.parse(data).error)
      }
      return listResponseSchema.parse(data)
    },
  })
}

export function SkillsClient({
  agents,
  initialAgentName,
}: {
  agents: Agent[]
  initialAgentName?: string
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const queryClient = useQueryClient()
  const firstAgentName = agents[0]?.name ?? ""
  const initialAgentExists = agents.some((agent) => agent.name === initialAgentName)
  const startAgentName = initialAgentExists && initialAgentName ? initialAgentName : firstAgentName
  const [agentName, setAgentName] = React.useState(startAgentName)
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set())
  const [error, setError] = React.useState<string>()
  const [deleteNames, setDeleteNames] = React.useState<string[]>([])
  const [importOpen, setImportOpen] = React.useState(false)
  const [exporting, setExporting] = React.useState(false)
  const routeAgentName = searchParams.get("agent_name") ?? ""
  const pageToken =
    routeAgentName === "" || routeAgentName === agentName
      ? (searchParams.get("page_token") ?? "")
      : ""

  const skillsOptions = skillsQueryOptions(agentName, pageToken)
  const query = useQuery(skillsOptions)
  const skills = query.data?.skills ?? []

  function chooseAgent(name: string) {
    setSelected(new Set())
    setAgentName(name)
    router.replace(`/skills?agent_name=${encodeURIComponent(name)}` as Route)
  }

  async function refreshSkills() {
    await queryClient.invalidateQueries({ queryKey: skillsOptions.queryKey })
  }

  async function exportSkills(skillNames: string[]) {
    if (skillNames.length === 0 || exporting) {
      return
    }
    setError(undefined)
    setExporting(true)
    try {
      const response = await fetch("/api/skills/export", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentName,
          skillNames,
        }),
      })
      if (!response.ok) {
        setError(apiErrorSchema.parse(await response.json()).error)
        return
      }

      const href = URL.createObjectURL(await response.blob())
      const link = document.createElement("a")
      link.href = href
      link.download = `${agentName}-skills.zip`
      link.click()
      URL.revokeObjectURL(href)
    } finally {
      setExporting(false)
    }
  }

  async function deleteSelected() {
    if (deleteNames.length === 0) {
      return
    }
    setError(undefined)
    const response = await fetch("/api/skills/delete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agentName,
        skillNames: deleteNames,
      }),
    })
    if (!response.ok) {
      setError(apiErrorSchema.parse(await response.json()).error)
      return
    }

    setDeleteNames([])
    setSelected(new Set())
    await refreshSkills()
  }

  return (
    <>
      <div className="flex flex-col gap-3 px-4 pt-4 sm:flex-row sm:items-start sm:justify-between md:px-6 md:pt-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-normal">Skills</h1>
        </div>
        <SkillsActions
          disabled={!agentName}
          exporting={exporting}
          selectedCount={selected.size}
          onDelete={() => setDeleteNames([...selected])}
          onExport={() => void exportSkills([...selected])}
          onImport={() => setImportOpen(true)}
        />
      </div>
      <div className="bg-background flex min-h-14 flex-col gap-3 border-b px-4 py-2 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        {agents.length > 0 ? (
          <Select value={agentName} onValueChange={chooseAgent}>
            <SelectTrigger className="h-8 w-full min-w-0 rounded-md sm:w-64 sm:min-w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {agents.map((agent) => (
                  <SelectItem key={agent.name} value={agent.name}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : null}
      </div>
      {error ? (
        <div className="border-destructive/30 bg-destructive/5 text-destructive mx-4 mt-4 rounded-lg border p-3 text-sm md:mx-6">
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
        onExport={(name) => void exportSkills([name])}
      />
      <SkillImportDialog
        agentName={agentName}
        open={importOpen}
        setOpen={setImportOpen}
        onImported={refreshSkills}
      />
      <DeleteDialog
        names={deleteNames}
        open={deleteNames.length > 0}
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
          <DropdownMenuItem onSelect={onImport}>
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

function DeleteDialog({
  names,
  open,
  setOpen,
  onDelete,
}: {
  names: string[]
  open: boolean
  setOpen: (open: boolean) => void
  onDelete: () => Promise<void>
}) {
  const [pending, startTransition] = React.useTransition()
  const title = names.length === 1 ? `Delete ${names[0]}?` : `Delete ${names.length} skills?`

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>This will remove the skill permanently.</DialogDescription>
        </DialogHeader>
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
