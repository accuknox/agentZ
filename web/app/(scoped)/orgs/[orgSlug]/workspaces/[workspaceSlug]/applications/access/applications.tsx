"use client"

import { useState } from "react"
import { createColumnHelper, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import type { listGuardrailClientAccess } from "@/data/guardrail-client-access"
import { ClientGuardrailsPanel } from "@/components/guardrails/client-guardrails"
import { AdminDataGrid } from "@/components/admin-data-grid"
import { AdministrationState } from "@/components/administration"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"

type AccessClient = NonNullable<
  Awaited<ReturnType<typeof listGuardrailClientAccess>>
>["clients"][number]
const column = createColumnHelper<AccessClient>()

type ApplicationGuardrailAccessProps = {
  clients: AccessClient[]
  orgSlug: string
  workspaceSlug: string
}

export function ApplicationGuardrailAccess(props: ApplicationGuardrailAccessProps) {
  "use no memo"
  const { clients, orgSlug, workspaceSlug } = props

  const [selected, setSelected] = useState<AccessClient>()
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({
    data: clients,
    getCoreRowModel: getCoreRowModel(),
    columns: [
      column.accessor("name", {
        header: "Application",
        cell: ({ row }) => (
          <div className="flex flex-col gap-1">
            <Button
              className="h-auto justify-start p-0"
              onClick={() => setSelected(row.original)}
              type="button"
              variant="link"
            >
              {row.original.name}
            </Button>
            <span className="font-mono text-xs break-all text-muted-foreground">
              {row.original.clientId}
            </span>
          </div>
        ),
      }),
      column.accessor("principals", {
        header: "Authorized users",
        cell: ({ row }) => row.original.principals.join(", "),
      }),
      column.accessor("models", {
        header: "Approved models",
        cell: ({ row }) => row.original.models.join(", "),
      }),
      column.accessor("guardrails", {
        header: "Additional protection",
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            <Badge variant="outline">
              {row.original.guardrails.policies?.length ?? 0} additional{" "}
              {row.original.guardrails.policies?.length === 1 ? "policy" : "policies"}
            </Badge>
          </div>
        ),
      }),
    ],
  })
  return (
    <>
      <AdminDataGrid
        ariaLabel="Authorized application access"
        emptyState={
          <AdministrationState
            description="Applications appear after a user authorizes model access in this workspace. Required organization policies apply automatically."
            kind="empty"
            title="No authorized applications"
          />
        }
        layout={{
          name: { minWidth: 260 },
          principals: { minWidth: 220 },
          models: { minWidth: 200 },
          guardrails: { minWidth: 220 },
        }}
        rows={clients}
        table={table}
      />
      {selected ? (
        <Sheet
          open
          onOpenChange={(open) => {
            if (!open) setSelected(undefined)
          }}
        >
          <SheetContent size="lg">
            <SheetHeader>
              <SheetTitle>{selected.name}</SheetTitle>
              <SheetDescription>
                Guardrails for authorized access in this workspace
              </SheetDescription>
            </SheetHeader>
            <div className="min-h-0 overflow-y-auto">
              <ClientGuardrailsPanel
                clientId={selected.clientId}
                orgSlug={orgSlug}
                workspaceSlug={workspaceSlug}
              />
            </div>
          </SheetContent>
        </Sheet>
      ) : null}
    </>
  )
}
