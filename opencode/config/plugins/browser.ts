import { request } from "node:http"
import { readFile, mkdir, writeFile, realpath, stat } from "node:fs/promises"
import { basename, join, relative, resolve, sep } from "node:path"
import { tool, type Plugin, type ToolContext, type ToolResult } from "@opencode-ai/plugin"
import {
  zBrowserRequest,
  zBrowserResult,
  zBrowserDevTarget,
  zError,
} from "../lib/gateway/client/zod.gen"
import type { BrowserRequest, BrowserArtifact } from "../lib/gateway/client/types.gen"

const fields = zBrowserRequest.omit({ operation: true })
const definitions = {
  preview_status: [
    "status",
    "List this session's tabs, profiles, dialogs, downloads and control state.",
    {},
  ],
  preview_navigate: [
    "navigate",
    "Navigate to an HTTP(S) URL or the agent's development server port.",
    fields.pick({ tabId: true, url: true, port: true, protocol: true, path: true, timeoutMs: true })
      .shape,
  ],
  preview_snapshot: [
    "snapshot",
    "Inspect the page, accessibility tree, diagnostics and fresh aria-ref locators. includeImage=true returns an image; save=true saves a PNG.",
    fields.pick({ tabId: true, includeImage: true, save: true, timeoutMs: true }).shape,
  ],
  preview_evaluate: [
    "evaluate",
    "Execute JavaScript in the page. It can mutate state. Results are limited to 64 KB.",
    fields.pick({
      tabId: true,
      expression: true,
      awaitPromise: true,
      returnByValue: true,
      timeoutMs: true,
    }).shape,
  ],
  preview_wait_for: [
    "waitFor",
    "Wait for every supplied locator, text and URL condition.",
    fields.pick({ tabId: true, locator: true, text: true, urlIncludes: true, timeoutMs: true })
      .shape,
  ],
  preview_dialog: [
    "dialog",
    "Accept or dismiss a pending dialog. promptText answers a prompt.",
    fields.pick({ tabId: true, accept: true, promptText: true }).shape,
  ],
  preview_resize: [
    "resize",
    "Resize the viewport with fill, freeform dimensions, or a device preset and orientation.",
    fields.pick({
      tabId: true,
      mode: true,
      width: true,
      height: true,
      preset: true,
      orientation: true,
      zoom: true,
    }).shape,
  ],
  preview_set_appearance: [
    "setColorScheme",
    "Set dark, light or system appearance.",
    fields.pick({ tabId: true, colorScheme: true }).shape,
  ],
  preview_recording_start: [
    "recordingStart",
    "Start recording the tab.",
    fields.pick({ tabId: true }).shape,
  ],
  preview_recording_stop: [
    "recordingStop",
    "Stop recording and save its video in the agent's output directory.",
    fields.pick({ tabId: true }).shape,
  ],
  t3_preview_list: ["status", "List this session's browser tabs.", {}],
  t3_preview_close: [
    "close",
    "Close a browser tab belonging to this session.",
    fields.pick({ tabId: true }).shape,
  ],
} as const

export default (async (plugin) => {
  const tokenPath = process.env.AGENTZ_BROWSER_TOKEN_PATH
  if (!tokenPath) return { tool: {} }
  const token = await readFile(tokenPath, "utf8")
  const roots = new Map<string, string>()

  async function call(
    session: string,
    input: BrowserRequest,
    signal: AbortSignal,
    file?: { bytes: Buffer; contentType: string; locator?: string }
  ) {
    let root: string = roots.get(session) ?? session
    if (!roots.has(session)) {
      const ancestors = new Set<string>()
      for (;;) {
        if (ancestors.has(root)) throw new Error("Session ancestry contains a cycle")
        ancestors.add(root)
        const current = await plugin.client.session.get({ path: { id: root }, throwOnError: true })
        if (!current.data?.parentID) break
        root = current.data.parentID
      }
      roots.set(session, root)
    }
    const query = new URLSearchParams({ session: root })
    if (file) {
      if (input.tabId) query.set("tabId", input.tabId)
      if (file.locator) query.set("locator", file.locator)
    }
    const data = file?.bytes ?? Buffer.from(JSON.stringify(input))
    return new Promise<Buffer>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: 4098,
          path: `/?${query}`,
          method: file ? "PUT" : "POST",
          signal,
          headers: {
            authorization: `Bearer ${token}`,
            "x-browser-caller": session,
            "content-type": file ? file.contentType : "application/json",
            "content-length": data.length,
          },
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on("data", (chunk: Buffer) => chunks.push(chunk))
          response.on("error", reject)
          response.on("end", () => {
            const bytes = Buffer.concat(chunks)
            if (response.statusCode && response.statusCode >= 400) {
              const error = zError.parse(JSON.parse(bytes.toString()))
              reject(new Error(error.message))
              return
            }
            resolve(bytes)
          })
        }
      )
      req.on("error", reject)
      req.end(data)
    })
  }

  const exported = new Map<string, string>()
  async function exportArtifact(artifact: BrowserArtifact, context: ToolContext) {
    const saved = exported.get(artifact.id)
    if (saved) return saved
    if (artifact.sizeBytes > 50 * 1024 * 1024) throw new Error("Browser artifact exceeds 50 MiB")
    const output = join(context.directory, ".agentz", "browser")
    await mkdir(output, { recursive: true })
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: 4098,
          path: `/?${new URLSearchParams({ session: roots.get(context.sessionID) ?? context.sessionID, artifact: artifact.id })}`,
          signal: context.abort,
          headers: { authorization: `Bearer ${token}` },
        },
        (response) => {
          const chunks: Buffer[] = []
          let length = 0
          response.on("data", (chunk: Buffer) => {
            length += chunk.length
            if (length > 50 * 1024 * 1024) {
              response.destroy(new Error("Browser artifact exceeds 50 MiB"))
              return
            }
            chunks.push(chunk)
          })
          response.on("error", reject)
          response.on("end", () =>
            response.statusCode === 200
              ? resolve(Buffer.concat(chunks))
              : reject(new Error("Browser artifact unavailable"))
          )
        }
      )
      req.on("error", reject)
      req.end()
    })
    const path = join(output, `${artifact.id}-${basename(artifact.fileName)}`)
    await writeFile(path, bytes)
    exported.set(artifact.id, path)
    return path
  }

  async function execute(
    input: BrowserRequest,
    context: ToolContext,
    name: string
  ): Promise<ToolResult> {
    context.abort.throwIfAborted()
    await context.ask({
      permission: name,
      patterns: ["*"],
      always: ["*"],
      metadata: { tabId: input.tabId },
    })
    const result = zBrowserResult.parse(
      JSON.parse((await call(context.sessionID, input, context.abort)).toString())
    )
    context.metadata({ title: name, metadata: { tabId: result.tabId } })
    const artifactPath = result.artifact
      ? await exportArtifact(result.artifact, context)
      : undefined
    const downloads = []
    for (const artifact of result.downloads ?? []) {
      if (artifact.sizeBytes <= 50 * 1024 * 1024)
        downloads.push({ id: artifact.id, path: await exportArtifact(artifact, context) })
    }
    const { screenshot, ...metadata } = result
    return {
      title: name,
      output: JSON.stringify({ ...metadata, artifactPath, downloadPaths: downloads }),
      attachments: screenshot
        ? [
            {
              type: "file",
              mime: "image/png",
              url: `data:image/png;base64,${screenshot}`,
              filename: "browser.png",
            },
          ]
        : undefined,
    }
  }
  const tools = Object.entries(definitions).map(([name, [operation, description, args]]) => [
    name,
    tool({
      description,
      args,
      execute: (input, context) => execute({ ...input, operation }, context, name),
    }),
  ])
  const open = tool({
    description:
      "Open or reuse your tab. target connects to a development server in the agent's environment. reuseExistingTab=false creates a tab; open=false keeps it in the background.",
    args: {
      ...fields.pick({
        url: true,
        tabId: true,
        profileId: true,
        reuseExistingTab: true,
        open: true,
        timeoutMs: true,
      }).shape,
      target: zBrowserDevTarget.optional(),
    },
    execute: ({ target, ...input }, context) =>
      execute(
        {
          ...input,
          operation: "open",
          port: target?.port,
          protocol: target?.protocol,
          path: target?.path,
        },
        context,
        "preview_open"
      ),
  })
  const actions = ["click", "type", "hover", "select", "drag", "upload", "press", "scroll"] as const
  const act = tool({
    description:
      "Act on your tab using a fresh aria-ref locator or coordinates. Upload paths must be regular files under the agent home. Human takeover blocks agent mutations.",
    args: {
      ...fields.pick({
        tabId: true,
        timeoutMs: true,
        locator: true,
        selector: true,
        x: true,
        y: true,
        button: true,
        clickCount: true,
        text: true,
        clear: true,
        key: true,
        modifiers: true,
        deltaX: true,
        deltaY: true,
        values: true,
        source: true,
        target: true,
        paths: true,
      }).shape,
      action: tool.schema.enum(actions),
    },
    async execute({ action, ...input }, context) {
      await context.ask({
        permission: "preview_act",
        patterns: ["*"],
        always: ["*"],
        metadata: { tabId: input.tabId, action },
      })
      if (action === "upload" && input.paths?.length) {
        const home = await realpath(process.env.AGENTZ_HOME ?? "/home/agentz")
        const status = zBrowserResult.parse(
          JSON.parse(
            (await call(context.sessionID, { operation: "status" }, context.abort)).toString()
          )
        )
        const tabId = input.tabId ?? status.tabs.find((tab) => tab.ownedByCaller)?.id
        if (!tabId) throw new Error("No browser tab is open")
        const form = new FormData()
        let total = 0
        for (const path of input.paths) {
          const file = await realpath(resolve(context.directory, path))
          const within = relative(home, file)
          if (!within || within === ".." || within.startsWith(`..${sep}`))
            throw new Error("Upload file must be under the agent home")
          const info = await stat(file)
          total += info.size
          if (!info.isFile() || total > 50 * 1024 * 1024)
            throw new Error("Uploads must be regular files totalling at most 50 MiB")
          form.append("files", new Blob([await readFile(file)]), basename(file))
        }
        const upload = new Request("http://localhost", { method: "POST", body: form })
        const contentType = upload.headers.get("content-type")
        if (!contentType) throw new Error("Multipart content type is missing")
        await call(context.sessionID, { ...input, tabId, operation: "upload" }, context.abort, {
          bytes: Buffer.from(await upload.arrayBuffer()),
          contentType,
          locator: input.locator ?? input.selector,
        })
        return "Uploaded files"
      }
      return (
        await call(context.sessionID, { ...input, operation: action }, context.abort)
      ).toString()
    },
  })
  return {
    tool: { ...Object.fromEntries(tools), preview_open: open, preview_act: act },
    event: async ({ event }) => {
      if (event.type !== "session.deleted") return
      const session = event.properties.info.id
      if (!roots.has(session)) return
      await call(session, { operation: "closeSession" }, AbortSignal.timeout(10000)).catch(() => {})
      roots.delete(session)
    },
  }
}) satisfies Plugin
