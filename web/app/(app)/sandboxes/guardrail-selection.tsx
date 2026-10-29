"use client"

import { getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table"
import type { GuardrailAssignment, GuardrailPolicy, GuardrailSettings } from "@/lib/gateway/client"
import { AdminDataGrid } from "@/components/admin-data-grid"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"

type GuardrailSelectionProps = {
  assignment: GuardrailAssignment
  policies: GuardrailPolicy[]
  settings: GuardrailSettings
  onChange: (assignment: GuardrailAssignment) => void
}

export function GuardrailSelection({
  assignment,
  policies,
  settings,
  onChange,
}: GuardrailSelectionProps) {
  const selected = assignment.policies ?? []
  const missing = selected.filter(
    (ref) => !policies.some((policy) => policy.name === ref.name && policy.scope === ref.scope)
  )
  const missingRequired = settings.mandatoryPolicies.filter(
    (name) => !policies.some((policy) => policy.scope === "Organisation" && policy.name === name)
  )
  const columns: ColumnDef<GuardrailPolicy>[] = [
    {
      accessorKey: "displayName",
      header: "Name",
      cell: ({ row }) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate font-medium" title={row.original.displayName}>
            {row.original.displayName}
          </span>
          <Badge variant="outline">{row.original.scope}</Badge>
          {row.original.mandatory ? <Badge variant="secondary">Required</Badge> : null}
        </div>
      ),
    },
    {
      id: "checks",
      header: "Checks",
      cell: ({ row }) => row.original.checks.length,
    },
    {
      id: "attach",
      header: "",
      cell: ({ row }) => {
        const policy = row.original
        const checked = selected.some(
          (ref) => ref.name === policy.name && ref.scope === policy.scope
        )
        return (
          <div className="flex justify-end">
            <Switch
              aria-label={`Attach ${policy.displayName}`}
              checked={policy.mandatory || checked}
              disabled={policy.mandatory}
              onCheckedChange={(checked) =>
                onChange({
                  ...assignment,
                  policies: checked
                    ? [...selected, { scope: policy.scope, name: policy.name }]
                    : selected.filter(
                        (ref) => ref.scope !== policy.scope || ref.name !== policy.name
                      ),
                })
              }
            />
          </div>
        )
      },
    },
  ]

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table is not React Compiler compatible yet.
  const table = useReactTable({ data: policies, columns, getCoreRowModel: getCoreRowModel() })

  return (
    <>
      {missingRequired.map((name) => (
        <Alert key={name} variant="destructive">
          <AlertDescription>Required policy {name} is unavailable.</AlertDescription>
        </Alert>
      ))}
      {missing.map((ref) => (
        <Alert key={`${ref.scope}/${ref.name}`} variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-3">
            <span>{ref.name} is unavailable.</span>
            <Switch
              aria-label={`Remove unavailable policy ${ref.name}`}
              checked
              onCheckedChange={() =>
                onChange({
                  ...assignment,
                  policies: selected.filter(
                    (item) => item.scope !== ref.scope || item.name !== ref.name
                  ),
                })
              }
            />
          </AlertDescription>
        </Alert>
      ))}
      <div className="-mx-4 w-[calc(100%+2rem)] min-w-0 sm:-mx-6 sm:w-[calc(100%+3rem)]">
        <AdminDataGrid
          ariaLabel="Guardrail policies"
          emptyState={<p className="py-8 text-center text-muted-foreground">No policies found.</p>}
          layout={{
            displayName: { minWidth: 160, contentMaxWidth: 320 },
            checks: { minWidth: 80, width: 80 },
            attach: { minWidth: 56, width: 56 },
          }}
          rows={policies}
          table={table}
        />
      </div>
    </>
  )
}
