import { queryOptions } from "@tanstack/react-query"
import {
  runCodingGit,
  type CodingGitRequest,
  type CodingGitComparison,
  type CodingGitStash,
  type CodingThread,
} from "@/lib/gateway/client"
import { getGatewayBaseURL } from "@/lib/gateway/browser-runtime"
import type { GitParseResult, ParsedGitPatch } from "./review.worker"

export async function runWorkspaceGit(
  workspaceId: string,
  worktreeId: string,
  body: CodingGitRequest,
  signal?: AbortSignal
) {
  const result = await runCodingGit({
    baseUrl: await getGatewayBaseURL(),
    headers: { "X-AgentZ-Workspace-ID": workspaceId },
    path: { worktreeId },
    body,
    signal,
  })
  if (result.error) throw new Error(result.error.message)
  return result.data
}

export function gitQueries(
  {
    thread,
    workspaceId,
    visible,
    expanded,
  }: { thread: CodingThread; workspaceId: string; visible: boolean; expanded: boolean },
  comparison: CodingGitComparison,
  stash: CodingGitStash | undefined,
  stashPicker: boolean
) {
  const queryKey = ["coding", "review", workspaceId, thread.worktree.id, comparison, stash?.oid]
  return {
    review: queryOptions({
      queryKey,
      enabled: visible && expanded,
      staleTime: Infinity,
      gcTime: 30_000,
      refetchOnWindowFocus: false,
      structuralSharing: false,
      queryFn: async ({ signal, queryKey, client: queryClient }): Promise<ParsedGitPatch[]> => {
        const response = await runWorkspaceGit(
          workspaceId,
          thread.worktree.id,
          { operation: "diff", comparison, stash: stash?.oid },
          signal
        )
        const patches = response.patches ?? []
        const previous = new Map(
          queryClient.getQueryData<ParsedGitPatch[]>(queryKey)?.map((file) => [file.path, file])
        )
        const changed = patches.filter(
          (file) => previous.get(file.path)?.revision !== file.revision
        )
        if (changed.length) {
          const parsed = await new Promise<ParsedGitPatch[]>((resolve, reject) => {
            const worker = new Worker(new URL("./review.worker.ts", import.meta.url), {
              type: "module",
            })
            const abort = () => {
              worker.terminate()
              reject(new DOMException("Review canceled", "AbortError"))
            }
            signal.addEventListener("abort", abort, { once: true })
            worker.onmessage = ({ data }: MessageEvent<GitParseResult>) => {
              worker.terminate()
              signal.removeEventListener("abort", abort)
              if ("error" in data) reject(new Error(data.error))
              else resolve(data.files)
            }
            worker.onerror = () => {
              worker.terminate()
              signal.removeEventListener("abort", abort)
              reject(new Error("Could not start the diff parser"))
            }
            worker.postMessage(changed)
            if (signal.aborted) abort()
          })
          for (const file of parsed) {
            file.version = (previous.get(file.path)?.version ?? 0) + 1
            previous.set(file.path, file)
          }
        }
        return patches.flatMap((file) => {
          const parsed = previous.get(file.path)
          return parsed ? [parsed] : []
        })
      },
    }),
    stashes: queryOptions({
      queryKey: [
        "coding",
        "stashes",
        workspaceId,
        thread.worktree.project_id,
        thread.worktree.agent_name,
        thread.worktree.id,
      ],
      queryFn: async ({ signal }) =>
        (await runWorkspaceGit(workspaceId, thread.worktree.id, { operation: "stashes" }, signal))
          .stashes ?? [],
      enabled: visible && stashPicker,
      refetchInterval: visible && stashPicker ? 5000 : false,
    }),
  }
}
