import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs"
import type { CodingGitPatch } from "@/lib/gateway/client"

export type ParsedGitPatch = Omit<CodingGitPatch, "patch"> & {
  diff: FileDiffMetadata
  version: number
}

export type GitParseResult = { files: ParsedGitPatch[] } | { error: string }

// Parsing a 100K-line patch is synchronous. Keep it off the UI thread as well
// as highlighting; canceling the query terminates this worker and its buffers.
self.onmessage = (event: MessageEvent<CodingGitPatch[]>) => {
  try {
    const files = event.data.map(({ patch, ...file }): ParsedGitPatch => {
      const parsed = parsePatchFiles(patch, file.revision).flatMap((patch) => patch.files)
      const diff = parsed[0]
      if (!diff || parsed.length !== 1) throw new Error(`Could not parse the diff for ${file.path}`)
      return { ...file, diff, version: 1 }
    })
    self.postMessage({ files } satisfies GitParseResult)
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : "Could not parse comparison",
    } satisfies GitParseResult)
  }
}
