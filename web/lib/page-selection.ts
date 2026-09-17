import { z } from "zod"

export const selectionCookie = "agentz-selection-v1"

export const selectionPages = [
  "workflows/graphs",
  "workflows/triggers",
  "workflows/triggers/runs",
  "workflows/triggers/runs/graph",
  "lens/traces",
  "lens/mcp",
  "lens/runtime-telemetry",
  "lens/runtime-telemetry/file",
  "lens/runtime-telemetry/network",
  "secrets",
] as const

export type SelectionPage = (typeof selectionPages)[number]

const selectionSchema = z.object({
  agent_name: z.string().optional(),
  workflow_name: z.string().optional(),
  type: z.string().optional(),
  schedule_name: z.string().optional(),
  webhook_api_key_id: z.string().optional(),
  run_name: z.string().optional(),
  session_id: z.string().optional(),
})

export type PageSelection = z.infer<typeof selectionSchema>
export type SelectionField = keyof PageSelection

const historySchema = z.array(z.tuple([z.string(), z.enum(selectionPages), selectionSchema]))
export type SelectionHistory = z.infer<typeof historySchema>

/** Cookie data is the only untyped boundary; malformed preferences are disposable. */
export function readSelectionHistory(value: string | undefined): SelectionHistory {
  if (!value || value.length + selectionCookie.length > 3500) return []
  try {
    return historySchema.parse(JSON.parse(decodeURIComponent(value)))
  } catch {
    return []
  }
}

/** Groups keep composite identities together and children under their own parent. */
export function selectionGroups(page: SelectionPage, selection: PageSelection): SelectionField[][] {
  switch (page) {
    case "workflows/graphs":
      return [["agent_name"], ["workflow_name"]]
    case "workflows/triggers":
      return [["agent_name"], ["type"]]
    case "workflows/triggers/runs":
      return [
        ["agent_name"],
        ["type"],
        selection.type === "webhook"
          ? ["workflow_name", "webhook_api_key_id"]
          : ["schedule_name", "workflow_name"],
      ]
    case "workflows/triggers/runs/graph":
      return [["agent_name"], ["workflow_name"], ["run_name"]]
    case "lens/traces":
      return [["agent_name"], ["session_id"]]
    default:
      return [["agent_name"]]
  }
}

/** Explicit groups win; omitted children come from the most recent matching parent. */
export function restoreSelection(
  history: SelectionHistory,
  scope: string,
  page: SelectionPage,
  requested: PageSelection
): PageSelection {
  const selection: PageSelection = { ...requested }
  let candidates = history.filter(([key, route]) => key === scope && route === page)
  // Resolve type before choosing the schedule/webhook identity group.
  const groups = selectionGroups(page, {
    ...selection,
    type:
      selection.type ??
      candidates.find(
        ([, , value]) => !selection.agent_name || value.agent_name === selection.agent_name
      )?.[2].type,
  })
  for (const fields of groups) {
    if (!fields.some((field) => selection[field] !== undefined)) {
      const saved = candidates[0]?.[2]
      for (const field of fields) selection[field] = saved?.[field]
    }
    candidates = candidates.filter(([, , saved]) =>
      fields.every((field) => saved[field] === selection[field])
    )
  }
  return selection
}

/** Keep one child choice per parent, repairing only branches validated by the page. */
export function rememberSelection(
  history: SelectionHistory,
  scope: string,
  page: SelectionPage,
  selected: PageSelection,
  requested: PageSelection
): SelectionHistory {
  const groups = selectionGroups(page, requested)
  const invalid = groups.findIndex((fields) =>
    fields.some((field) => requested[field] !== undefined && requested[field] !== selected[field])
  )
  const parents = selectionGroups(page, selected).slice(0, -1).flat()
  const retained = history.filter(([key, route, saved]) => {
    if (key !== scope || route !== page) return true
    if (
      invalid >= 0 &&
      groups
        .slice(0, invalid + 1)
        .flat()
        .every((field) => saved[field] === requested[field])
    )
      return false
    return !parents.every((field) => saved[field] === selected[field])
  })
  if (selected.agent_name) retained.unshift([scope, page, selected])
  return retained
}

/** Bound the entire cookie, including histories from other accounts and workspaces. */
export function encodeSelectionHistory(history: SelectionHistory): string {
  const entries = [...history]
  let encoded = encodeURIComponent(JSON.stringify(entries))
  while (entries.length && selectionCookie.length + encoded.length > 3500) {
    // Preserve each page's latest default before keeping older parent histories.
    const duplicate = entries.findLastIndex(([scope, page], index) =>
      entries.slice(0, index).some(([key, route]) => key === scope && route === page)
    )
    entries.splice(duplicate > 0 ? duplicate : entries.length - 1, 1)
    encoded = encodeURIComponent(JSON.stringify(entries))
  }
  return encoded
}

/** Selection changes invalidate cursors, while unrelated filters remain in the URL. */
export function selectionURL(
  pathname: string,
  search: URLSearchParams,
  selection: PageSelection,
  resetPage: boolean
): string {
  const next = new URLSearchParams(search)
  for (const field of Object.keys(selectionSchema.shape)) next.delete(field)
  for (const [field, value] of Object.entries(selection)) {
    if (value) next.set(field, value)
  }
  if (resetPage) {
    for (const key of [
      "page_token",
      "token_stack",
      "telemetry_page_token",
      "telemetry_token_stack",
    ]) {
      next.delete(key)
    }
  }
  const query = next.toString()
  return query ? `${pathname}?${query}` : pathname
}
