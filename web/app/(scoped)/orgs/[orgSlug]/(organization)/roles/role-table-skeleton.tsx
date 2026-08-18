import { Skeleton } from "@/components/ui/skeleton"
import { AdministrationPageHeader } from "@/components/administration"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export function RolesPageSkeleton({ workspace = false }: { workspace?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-6" role="status">
      <span className="sr-only">Loading {workspace ? "Workspace Roles" : "Roles"}...</span>
      <AdministrationPageHeader actions={<Skeleton className="h-9 w-32" />} title="Roles" />
      <div aria-hidden className="flex flex-col gap-3">
        <div className="w-full min-w-0 border-b">
          <Table className="w-full min-w-3xl table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                {workspace ? <TableHead className="w-24">Scope</TableHead> : null}
                <TableHead className="w-20">Type</TableHead>
                <TableHead className="w-16 text-right">Users</TableHead>
                <TableHead className="w-16 text-right">Teams</TableHead>
                <TableHead className="w-28 text-right">Permissions</TableHead>
                <TableHead className="w-32">Dependencies</TableHead>
                <TableHead className="w-36">Updated</TableHead>
                {workspace ? null : (
                  <TableHead className="w-16">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {Array.from({ length: 5 }, (_, row) => (
                <TableRow key={row}>
                  <TableCell>
                    <Skeleton className="h-4 w-40" />
                  </TableCell>
                  {workspace ? (
                    <TableCell>
                      <Skeleton className="h-4 w-16" />
                    </TableCell>
                  ) : null}
                  <TableCell>
                    <Skeleton className="h-4 w-12" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="ml-auto size-4" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="ml-auto size-4" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="ml-auto h-4 w-6" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-24" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-24" />
                  </TableCell>
                  {workspace ? null : (
                    <TableCell>
                      <Skeleton className="h-4 w-8" />
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-end gap-2 px-2">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-16" />
        </div>
      </div>
    </div>
  )
}
