import * as React from "react"

import { cn } from "@/lib/utils"

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div
      data-slot="table-container"
      className="relative w-full max-w-full min-w-0 overflow-x-auto overflow-y-hidden overscroll-x-contain"
    >
      <table
        data-slot="table"
        className={cn(
          "[&_thead_tr]:bg-muted/25 [&_thead_tr:hover]:bg-muted/25 w-max min-w-full table-auto caption-bottom text-sm",
          className
        )}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-0", className)} {...props} />
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("bg-muted/50 border-t font-medium [&>tr]:last:border-b-0", className)}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "bg-background hover:bg-muted/30 has-aria-expanded:bg-muted/30 data-[state=selected]:bg-muted/40 border-b transition-colors",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "text-muted-foreground h-9 border-b px-6 text-left align-middle text-xs font-medium whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ children, className, ...props }: React.ComponentProps<"td">) {
  const empty = children === null || children === undefined || children === ""

  return (
    <td
      data-slot="table-cell"
      className={cn(
        "[&_time]:text-muted-foreground h-14 px-6 py-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    >
      {empty ? <span className="text-muted-foreground">_</span> : children}
    </td>
  )
}

/** EmptyValue renders the standard placeholder for unavailable table data. */
function EmptyValue() {
  return <span className="text-muted-foreground">_</span>
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("text-muted-foreground mt-4 text-sm", className)}
      {...props}
    />
  )
}

export {
  EmptyValue,
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
