"use client"

import * as React from "react"

type FileTab = {
  name: string
  path: string
}

type RootState = {
  selected: string | null
  tabs: FileTab[]
}

type WorkspaceState = {
  dirtyAgent?: string
  openAgent?: string
  roots: Record<string, RootState>
}

type FileWorkspace = WorkspaceState & {
  closeRoot: (root: string) => void
  closeTab: (root: string, path: string) => void
  deleteEntry: (root: string, path: string) => void
  moveEntry: (root: string, path: string, target: string) => void
  openTab: (root: string, tab: FileTab) => void
  setAgentDirty: (agent: string, dirty: boolean) => void
  setSelected: (root: string, path: string) => void
  toggleAgent: (agent: string) => void
}

const emptyRoot: RootState = {
  selected: null,
  tabs: [],
}

const FileWorkspaceContext = React.createContext<FileWorkspace | null>(null)

export function FileWorkspaceProvider({
  children,
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const [state, setState] = React.useState<WorkspaceState>({
    roots: {},
  })
  const actions = React.useMemo<Omit<FileWorkspace, keyof WorkspaceState>>(
    () => ({
      closeRoot: (root) =>
        setState((state) => {
          if (!state.roots[root]) return state
          const roots = { ...state.roots }
          delete roots[root]
          return { ...state, roots }
        }),
      closeTab: (root, path) =>
        setState((state) => {
          const current = state.roots[root]
          if (!current) return state

          const index = current.tabs.findIndex((tab) => tab.path === path)
          if (index === -1) return state

          const tabs = current.tabs.filter((tab) => tab.path !== path)
          const selected =
            current.selected === path
              ? (tabs[Math.min(index, tabs.length - 1)]?.path ?? null)
              : current.selected

          return {
            ...state,
            roots: { ...state.roots, [root]: { ...current, selected, tabs } },
          }
        }),
      deleteEntry: (root, path) =>
        setState((state) => {
          const current = state.roots[root]
          if (!current) return state

          const prefix = `${path}/`
          const tabs = current.tabs.filter(
            (tab) => tab.path !== path && !tab.path.startsWith(prefix)
          )
          if (tabs.length === current.tabs.length) return state

          const selected =
            current.selected === path || current.selected?.startsWith(prefix)
              ? (tabs[0]?.path ?? null)
              : current.selected

          return {
            ...state,
            roots: {
              ...state.roots,
              [root]: {
                selected,
                tabs,
              },
            },
          }
        }),
      moveEntry: (root, path, target) =>
        setState((state) => {
          const current = state.roots[root]
          if (!current) return state

          const prefix = `${path}/`
          const selectedMoves =
            current.selected === path || current.selected?.startsWith(prefix) === true
          const tabMoves = current.tabs.some(
            (tab) => tab.path === path || tab.path.startsWith(prefix)
          )
          if (!selectedMoves && !tabMoves) return state

          return {
            ...state,
            roots: {
              ...state.roots,
              [root]: {
                selected:
                  current.selected === path
                    ? target
                    : current.selected?.startsWith(prefix)
                      ? `${target}/${current.selected.slice(prefix.length)}`
                      : current.selected,
                tabs: current.tabs.map((tab) =>
                  tab.path === path
                    ? { name: target.slice(target.lastIndexOf("/") + 1), path: target }
                    : tab.path.startsWith(prefix)
                      ? { ...tab, path: `${target}/${tab.path.slice(prefix.length)}` }
                      : tab
                ),
              },
            },
          }
        }),
      openTab: (root, tab) =>
        setState((state) => {
          const current = state.roots[root] ?? emptyRoot
          const open = current.tabs.some((item) => item.path === tab.path)
          if (open && current.selected === tab.path) return state

          const tabs = open ? current.tabs : [...current.tabs, tab]
          return {
            ...state,
            roots: {
              ...state.roots,
              [root]: { ...current, selected: tab.path, tabs },
            },
          }
        }),
      setAgentDirty: (agent, dirty) =>
        setState((state) => {
          if (dirty) return state.dirtyAgent === agent ? state : { ...state, dirtyAgent: agent }
          return state.dirtyAgent === agent ? { ...state, dirtyAgent: undefined } : state
        }),
      setSelected: (root, selected) =>
        setState((state) => {
          const current = state.roots[root] ?? emptyRoot
          if (current.selected === selected) return state

          return {
            ...state,
            roots: {
              ...state.roots,
              [root]: { ...current, selected },
            },
          }
        }),
      toggleAgent: (agent) =>
        setState((state) => ({
          ...state,
          openAgent: state.openAgent === agent ? undefined : agent,
        })),
    }),
    []
  )
  const value = React.useMemo(() => ({ ...state, ...actions }), [actions, state])

  return React.createElement(FileWorkspaceContext, { value }, children)
}

export function useFileWorkspace(): FileWorkspace {
  const state = React.use(FileWorkspaceContext)
  if (!state) throw new Error("useFileWorkspace must be used within FileWorkspaceProvider")
  return state
}
