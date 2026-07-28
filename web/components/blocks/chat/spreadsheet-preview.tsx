"use client"

import * as React from "react"
import { FileSpreadsheet } from "lucide-react"
import { read, utils, type WorkBook } from "xlsx"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

const maxColumns = 50
const maxRows = 500
const maxSheets = 25

export function DelimitedPreview({
  content,
  delimiter,
}: {
  content: string
  delimiter: "," | "\t"
}): React.JSX.Element {
  const workbook = React.useMemo(() => {
    try {
      return read(content, {
        FS: delimiter,
        cellHTML: false,
        sheetRows: maxRows + 1,
        type: "string",
      })
    } catch {
      return null
    }
  }, [content, delimiter])

  return workbook ? <WorkbookPreview workbook={workbook} /> : <InvalidSpreadsheet />
}

export function SpreadsheetPreview({ file }: { file: Blob }): React.JSX.Element {
  const [workbook, setWorkbook] = React.useState<WorkBook | null>()

  React.useEffect(() => {
    let active = true
    void file
      .arrayBuffer()
      .then((buffer) => {
        if (!active) return
        try {
          setWorkbook(
            read(buffer, {
              cellHTML: false,
              sheetRows: maxRows + 1,
              type: "array",
            })
          )
        } catch {
          setWorkbook(null)
        }
      })
      .catch(() => {
        if (active) setWorkbook(null)
      })

    return () => {
      active = false
    }
  }, [file])

  if (workbook === undefined) {
    return (
      <div
        aria-live="polite"
        className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm"
        role="status"
      >
        <Spinner /> Rendering spreadsheet...
      </div>
    )
  }

  return workbook ? <WorkbookPreview workbook={workbook} /> : <InvalidSpreadsheet />
}

function WorkbookPreview({ workbook }: { workbook: WorkBook }): React.JSX.Element {
  const sheets = workbook.SheetNames.slice(0, maxSheets)
  const [selected, setSelected] = React.useState(sheets[0])
  const rows = React.useMemo(() => {
    const sheet = selected ? workbook.Sheets[selected] : undefined
    return sheet
      ? utils.sheet_to_json<string[]>(sheet, {
          blankrows: true,
          defval: "",
          header: 1,
          raw: false,
        })
      : []
  }, [selected, workbook])
  const visibleRows = rows.slice(0, maxRows)
  const columns = Math.min(
    maxColumns,
    visibleRows.reduce((count, row) => Math.max(count, row.length), 0)
  )
  const limited =
    workbook.SheetNames.length > maxSheets ||
    rows.length > maxRows ||
    visibleRows.some((row) => row.length > maxColumns)

  if (!selected) {
    return <InvalidSpreadsheet />
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {sheets.length > 1 ? (
        <div
          aria-label="Worksheets"
          className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b px-2"
          role="tablist"
        >
          {sheets.map((sheet) => (
            <Button
              aria-selected={selected === sheet}
              key={sheet}
              onClick={() => setSelected(sheet)}
              role="tab"
              size="sm"
              variant={selected === sheet ? "secondary" : "ghost"}
            >
              {sheet}
            </Button>
          ))}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-max min-w-full border-separate border-spacing-0 text-xs">
          <thead>
            <tr>
              <th className="bg-muted sticky top-0 left-0 z-20 h-8 min-w-12 border-r border-b" />
              {Array.from({ length: columns }, (_, column) => (
                <th
                  className="bg-muted text-muted-foreground sticky top-0 z-10 h-8 min-w-32 border-r border-b px-3 text-left font-mono font-medium"
                  key={column}
                  scope="col"
                >
                  {utils.encode_col(column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, index) => (
              <tr key={index}>
                <th
                  className="bg-muted text-muted-foreground sticky left-0 h-8 border-r border-b px-2 text-right font-mono font-normal"
                  scope="row"
                >
                  {index + 1}
                </th>
                {Array.from({ length: columns }, (_, column) => (
                  <td
                    className="h-8 max-w-80 min-w-32 overflow-hidden border-r border-b px-3 whitespace-nowrap"
                    key={column}
                    title={row[column]}
                  >
                    {row[column]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {visibleRows.length === 0 ? (
          <p className="text-muted-foreground p-6 text-center text-sm">This sheet is empty</p>
        ) : null}
      </div>
      {limited ? (
        <p className="text-muted-foreground shrink-0 border-t px-3 py-2 text-xs">
          Preview limited to {maxSheets} sheets, {maxRows} rows, and {maxColumns} columns.
        </p>
      ) : null}
    </div>
  )
}

function InvalidSpreadsheet(): React.JSX.Element {
  return (
    <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 text-sm">
      <FileSpreadsheet className="size-8" />
      This spreadsheet could not be rendered
    </div>
  )
}
