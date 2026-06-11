"use client"

import * as React from "react"
import { queryOptions, useQuery } from "@tanstack/react-query"
import type { LucideIcon } from "lucide-react"
import {
  Box,
  Check,
  ChevronLeft,
  ChevronRight,
  Code,
  Globe,
  FileBadge,
  PackagePlus,
  Search,
  User,
  X,
} from "lucide-react"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { searchNixPackagesAction, type NixPackage } from "@/data/nixpkgs.actions"
import { cn } from "@/lib/utils"

const minQueryLength = 2
const pageSize = 8
const searchDelayMs = 150
const packageSearchStaleMs = 5 * 60 * 1000
const emptyPackages: NixPackage[] = []

type PackageFilter = "all" | "installed" | "not-installed" | "selected"

type PackageRow = {
  attrName: string
  pkg?: NixPackage
}

const nixPackagesQueryOptions = (query: string) =>
  queryOptions({
    queryKey: ["nix-packages", query],
    queryFn: async () => {
      if (query.length < minQueryLength) return { packages: [], error: undefined }
      return searchNixPackagesAction(query, 0, 30)
    },
    staleTime: packageSearchStaleMs,
    enabled: query.length >= minQueryLength,
  })

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = React.useState(value)

  React.useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(id)
  }, [value, delay])

  return debounced
}

function maintainerLabel(pkg: NixPackage) {
  return pkg.package_maintainers
    .map((m) => m.name ?? m.github ?? m.email)
    .filter(Boolean)
    .join(", ")
}

function licenseLabel(pkg: NixPackage) {
  return pkg.package_license
    .map((license) => license.fullName)
    .filter(Boolean)
    .join(", ")
}

function PackageDetail({
  children,
  icon: Icon,
  label,
}: {
  children: React.ReactNode
  icon: LucideIcon
  label: string
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
        <Icon className="size-3.5" />
        {label}
      </dt>
      <dd className="text-foreground min-w-0 text-sm">{children}</dd>
    </div>
  )
}

function PackageMeta({ children, icon: Icon }: { children: React.ReactNode; icon: LucideIcon }) {
  return (
    <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{children}</span>
    </span>
  )
}

function PackageAction({
  attrName,
  isSelected,
  label,
  onToggle,
}: {
  attrName: string
  isSelected: boolean
  label: string
  onToggle: (attrName: string) => void
}) {
  return (
    <Button
      type="button"
      variant={isSelected ? "secondary" : "outline"}
      size="sm"
      className="h-8 shrink-0"
      aria-label={isSelected ? `Remove ${label}` : `Add ${label}`}
      onClick={(event) => {
        event.stopPropagation()
        onToggle(attrName)
      }}
    >
      {isSelected ? <Check data-icon="inline-start" /> : <PackagePlus data-icon="inline-start" />}
      {isSelected ? "Selected" : "Select"}
    </Button>
  )
}

function PackageResult({
  isSelected,
  onToggle,
  row,
}: {
  isSelected: boolean
  onToggle: (attrName: string) => void
  row: PackageRow
}) {
  const pkg = row.pkg
  const attrName = row.attrName
  const label = pkg?.package_attr_name ?? attrName
  const pname = pkg?.package_pname && pkg.package_pname !== label ? pkg.package_pname : ""
  const maintainer = pkg ? maintainerLabel(pkg) : ""
  const licenses = pkg ? licenseLabel(pkg) : ""
  const hasDetails =
    pkg != null &&
    (pkg.package_homepage.length > 0 || licenses.length > 0 || pkg.package_programs.length > 0)

  return (
    <AccordionItem
      value={attrName}
      className={cn(
        "group/package-row data-[state=open]:bg-muted/20 px-4",
        isSelected && "bg-muted/30"
      )}
    >
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-3 py-3">
        <div className="flex min-w-0 flex-col gap-1.5 text-left">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <AccordionTrigger className="w-fit max-w-full flex-none justify-start rounded-none p-0 hover:no-underline **:data-[slot=accordion-trigger-icon]:hidden">
              <span className="hover:text-primary truncate font-mono text-base font-semibold transition-colors hover:underline">
                {label}
              </span>
            </AccordionTrigger>
            {pkg?.package_pversion ? (
              <span className="text-muted-foreground font-mono text-xs">
                v{pkg.package_pversion}
              </span>
            ) : null}
          </div>
          {pkg ? (
            pkg.package_description ? (
              <p className="text-foreground line-clamp-1 text-sm font-normal">
                {pkg.package_description}
              </p>
            ) : null
          ) : (
            <p className="text-foreground line-clamp-1 text-sm font-normal">
              Package details are not loaded yet.
            </p>
          )}
          <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-1">
            {maintainer ? <PackageMeta icon={User}>{maintainer}</PackageMeta> : null}
            {pname ? (
              <PackageMeta icon={Box}>
                <span className="font-mono">{pname}</span>
              </PackageMeta>
            ) : null}
          </div>
        </div>
        <PackageAction
          attrName={attrName}
          isSelected={isSelected}
          label={label}
          onToggle={onToggle}
        />
      </div>
      <AccordionContent className="pt-4 pb-4">
        {!pkg ? (
          <p className="text-muted-foreground text-sm">
            Search for this package to load package details.
          </p>
        ) : hasDetails ? (
          <dl className="grid gap-3 sm:grid-cols-3">
            {pkg.package_homepage.length > 0 ? (
              <PackageDetail icon={Globe} label="Homepage">
                <div className="flex min-w-0 flex-col gap-1">
                  {pkg.package_homepage.map((href) => (
                    <a
                      key={href}
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-foreground truncate"
                    >
                      {href}
                    </a>
                  ))}
                </div>
              </PackageDetail>
            ) : null}
            {licenses ? (
              <PackageDetail icon={FileBadge} label="License">
                {licenses}
              </PackageDetail>
            ) : null}
            {pkg.package_programs.length > 0 ? (
              <PackageDetail icon={Code} label="Programs">
                <span className="font-mono">{pkg.package_programs.join(", ")}</span>
              </PackageDetail>
            ) : null}
          </dl>
        ) : (
          <p className="text-muted-foreground text-sm">No package details available.</p>
        )}
      </AccordionContent>
    </AccordionItem>
  )
}

export function PackageSearch({
  installed,
  onSelectedChangeAction,
  selected,
}: {
  installed: string[]
  onSelectedChangeAction: (packages: string[]) => void
  selected: string[]
}) {
  const [query, setQuery] = React.useState("")
  const [filter, setFilter] = React.useState<PackageFilter>("all")
  const [page, setPage] = React.useState(0)
  const searchRef = React.useRef<HTMLInputElement>(null)
  const debounced = useDebounce(query.trim(), searchDelayMs)
  const installedSet = React.useMemo(() => new Set(installed), [installed])
  const selectedSet = React.useMemo(() => new Set(selected), [selected])

  const { data, isFetching } = useQuery(nixPackagesQueryOptions(debounced))

  const packages = data?.packages ?? emptyPackages
  const packageByAttrName = React.useMemo(
    () => new Map(packages.map((pkg) => [pkg.package_attr_name, pkg])),
    [packages]
  )
  const rows = React.useMemo(() => {
    switch (filter) {
      case "installed":
        return installed.map((attrName) => ({
          attrName,
          pkg: packageByAttrName.get(attrName),
        }))
      case "not-installed":
        return selected
          .filter((attrName) => !installedSet.has(attrName))
          .map((attrName) => ({
            attrName,
            pkg: packageByAttrName.get(attrName),
          }))
      case "selected":
        return selected.map((attrName) => ({
          attrName,
          pkg: packageByAttrName.get(attrName),
        }))
      case "all":
        return packages.map((pkg) => ({
          attrName: pkg.package_attr_name,
          pkg,
        }))
    }
  }, [filter, installed, installedSet, packageByAttrName, packages, selected])
  const searchDependent = filter === "all"
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize))
  const currentPage = Math.min(page, pageCount - 1)
  const pagedRows = rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize)
  const pageStart = rows.length === 0 ? 0 : currentPage * pageSize + 1
  const pageEnd = Math.min(rows.length, (currentPage + 1) * pageSize)
  const hasError = data?.error != null

  React.useEffect(() => {
    searchRef.current?.focus()
  }, [])

  const togglePackage = (attrName: string) => {
    if (selectedSet.has(attrName)) {
      onSelectedChangeAction(selected.filter((pkg) => pkg !== attrName))
      return
    }

    onSelectedChangeAction([...selected, attrName])
  }

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="text-muted-foreground text-sm">{selected.length} selected</div>
        <Tabs
          value={filter}
          onValueChange={(value) => {
            setFilter(value as PackageFilter)
            setPage(0)
          }}
        >
          <TabsList className="h-9 w-full lg:w-auto">
            <TabsTrigger value="all" className="px-4">
              All
            </TabsTrigger>
            <TabsTrigger value="installed" className="px-4">
              Installed
            </TabsTrigger>
            <TabsTrigger value="not-installed" className="px-4">
              Not Installed
            </TabsTrigger>
            <TabsTrigger value="selected" className="px-4">
              Selected
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <InputGroup className="h-9">
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput
          ref={searchRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setPage(0)
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
            }
          }}
          placeholder="Search packages..."
          autoComplete="off"
        />
        {query ? (
          <InputGroupAddon align="inline-end">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label="Clear package search"
              onClick={() => {
                setQuery("")
                setPage(0)
              }}
            >
              <X />
            </Button>
          </InputGroupAddon>
        ) : null}
      </InputGroup>

      {searchDependent && isFetching && packages.length === 0 ? (
        <div className="text-muted-foreground flex items-center justify-center gap-2 rounded border py-10 text-sm">
          <Spinner />
          Searching...
        </div>
      ) : null}
      {searchDependent && hasError ? (
        <div className="border-destructive/30 bg-destructive/5 text-destructive rounded border p-3 text-sm">
          {data?.error?.message ?? "Search failed"}
        </div>
      ) : null}
      {searchDependent && !isFetching && debounced.length < minQueryLength ? (
        <div className="text-muted-foreground rounded border py-10 text-center text-sm">
          Search across 100K packages.
        </div>
      ) : null}
      {searchDependent &&
      !isFetching &&
      debounced.length >= minQueryLength &&
      rows.length === 0 &&
      !hasError ? (
        <div className="text-muted-foreground rounded border py-10 text-center text-sm">
          No packages found.
        </div>
      ) : null}
      {!searchDependent && rows.length === 0 ? (
        <div className="text-muted-foreground rounded border py-10 text-center text-sm">
          {filter === "installed"
            ? "No packages installed."
            : filter === "not-installed"
              ? "No packages selected that are not already installed."
              : "No packages selected."}
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div className="flex flex-col gap-4">
          <Accordion type="multiple" className="overflow-hidden rounded border">
            {pagedRows.map((row) => (
              <PackageResult
                key={row.attrName}
                row={row}
                isSelected={selectedSet.has(row.attrName)}
                onToggle={togglePackage}
              />
            ))}
          </Accordion>
          <div className="text-muted-foreground flex flex-col gap-3 px-1 text-sm sm:flex-row sm:items-center sm:justify-between">
            <span>
              {pageStart}-{pageEnd} of {rows.length}
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setPage((value) => Math.max(0, value - 1))}
                disabled={currentPage === 0}
              >
                <ChevronLeft data-icon="inline-start" />
                Previous
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
                disabled={currentPage >= pageCount - 1}
              >
                Next
                <ChevronRight data-icon="inline-end" />
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
