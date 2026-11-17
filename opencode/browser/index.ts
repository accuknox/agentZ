import { createReadStream } from "node:fs"
import { pipeline } from "node:stream/promises"
import { createServer } from "node:http"
import { timingSafeEqual, randomUUID } from "node:crypto"
import { readFile, mkdir, rm, writeFile, stat, open, rename } from "node:fs/promises"
import { basename, join } from "node:path"
import {
  chromium,
  type BrowserContext,
  type Page,
  type CDPSession,
  type Dialog,
  type FileChooser,
  type Locator,
} from "playwright-core"
import { WebSocketServer, WebSocket } from "ws"
import { z } from "zod"
import { zBrowserRequest, zBrowserInput } from "../config/lib/gateway/client/zod.gen"
import type {
  BrowserRequest,
  BrowserResult,
  BrowserTab,
  BrowserProfile,
  BrowserArtifact,
  BrowserDiagnostic,
  BrowserPreset,
  BrowserInput,
} from "../config/lib/gateway/client/types.gen"
import { Control } from "./control"
import { recordingEncoderScript } from "./recording"

const root = process.env.BROWSER_DATA ?? "/var/lib/browser"
const scratch = process.env.BROWSER_TEMP ?? "/tmp/browser"
const port = Number(process.env.BROWSER_PORT ?? "4098")
const token = await readFile(process.env.BROWSER_TOKEN_PATH ?? "/var/run/agentz/browser/token")
const epoch = randomUUID()
const profileControl = new Control()
const tabs = new Map<string, Tab>()
const contexts = new Map<string, Promise<BrowserContext>>()
const artifacts = new Map<string, { session: string; path: string; info: BrowserArtifact }>()
const presets: BrowserPreset[] = [
  { id: "iphone-se", label: "iPhone SE", width: 375, height: 667 },
  { id: "iphone-xr", label: "iPhone XR", width: 414, height: 896 },
  { id: "iphone-12-pro", label: "iPhone 12 Pro", width: 390, height: 844 },
  {
    id: "iphone-14-pro-max",
    label: "iPhone 14 Pro Max",
    width: 430,
    height: 932,
  },
  { id: "pixel-7", label: "Pixel 7", width: 412, height: 915 },
  {
    id: "samsung-galaxy-s8-plus",
    label: "Samsung Galaxy S8+",
    width: 360,
    height: 740,
  },
  {
    id: "samsung-galaxy-s20-ultra",
    label: "Samsung Galaxy S20 Ultra",
    width: 412,
    height: 915,
  },
  { id: "ipad-mini", label: "iPad Mini", width: 768, height: 1024 },
  { id: "ipad-air", label: "iPad Air", width: 820, height: 1180 },
  { id: "ipad-pro", label: "iPad Pro", width: 1024, height: 1366 },
  { id: "surface-pro-7", label: "Surface Pro 7", width: 912, height: 1368 },
  { id: "surface-duo", label: "Surface Duo", width: 540, height: 720 },
  { id: "galaxy-z-fold-5", label: "Galaxy Z Fold 5", width: 344, height: 882 },
  {
    id: "asus-zenbook-fold",
    label: "Asus Zenbook Fold",
    width: 853,
    height: 1280,
  },
  {
    id: "samsung-galaxy-a51-71",
    label: "Samsung Galaxy A51/71",
    width: 412,
    height: 914,
  },
  { id: "nest-hub", label: "Nest Hub", width: 1024, height: 600 },
  { id: "nest-hub-max", label: "Nest Hub Max", width: 1280, height: 800 },
]
const profiles = new Map<string, BrowserProfile>([
  ["default", { id: "default", name: "Default", incognito: false }],
  ["incognito", { id: "incognito", name: "Incognito", incognito: true }],
])
const profileFile = join(root, "profiles.json")
await mkdir(root, { recursive: true, mode: 0o700 })
await rm(scratch, { recursive: true, force: true })
await mkdir(scratch, { recursive: true, mode: 0o700 })
const catalogFile = await open(profileFile, "a+", 0o600)
const saved = await catalogFile.readFile("utf8")
await catalogFile.close()
const catalog = z
  .object({
    profiles: z
      .array(
        z.object({ id: z.uuid(), name: z.string().min(1).max(48), incognito: z.literal(false) })
      )
      .max(22),
    defaultProfileId: z.string(),
  })
  .parse(JSON.parse(saved || '{"profiles":[],"defaultProfileId":"default"}'))
for (const profile of catalog.profiles) profiles.set(profile.id, profile)
let defaultProfileId = profiles.has(catalog.defaultProfileId) ? catalog.defaultProfileId : "default"

declare global {
  interface Window {
    __agentzRecorder: {
      frame(base64: string, cssWidth: number): Promise<boolean>
      cursor(x: number, y: number, click: boolean): void
      stop(): Promise<{
        mimeType: string | null
        count: number
        bytes: number
      }>
      chunk(index: number): Promise<string>
    }
  }
}
interface Recording {
  page: Page
  context: BrowserContext
  pending: Promise<unknown>
  busy: boolean
}

interface Tab {
  id: string
  session: string
  caller: string
  profile: string
  page: Page
  cdp: CDPSession
  control: Control
  viewers: Map<string, { socket: WebSocket; inFlight: boolean; pending: Buffer | null }>
  refs: Map<string, Locator>
  diagnostics: BrowserDiagnostic[]
  dialog: Dialog | null
  chooser: FileChooser | null
  recording: Recording | null
  width: number
  height: number
  zoom: number
  colorScheme: "system" | "light" | "dark"
  used: number
  error?: string
  opener?: string
  title: string
  loading: boolean
  snapshot: number
  cast: Promise<void>
  castQuality: number
  frame: Buffer | null
  reveal: number
  cursor?: { x: number; y: number; click: boolean }
  keys: Set<string>
  buttons: Set<"left" | "right" | "middle">
  stop?: () => void
}

function authorized(header = "", host = "") {
  let hostname: string
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  if (!["127.0.0.1", "localhost", "[::1]", process.env.BROWSER_HOST].includes(hostname))
    return false
  const supplied = Buffer.from(header.replace(/^Bearer /, ""))
  return supplied.length === token.length && timingSafeEqual(supplied, token)
}

async function context(profile: string, session: string) {
  const selected = profiles.get(profile)
  if (!selected) throw new Error("Browser profile not found")
  const key = selected.incognito ? `${profile}:${session}` : profile
  let pending = contexts.get(key)
  if (!pending) {
    const directory = join(
      selected.incognito ? scratch : root,
      selected.incognito ? randomUUID() : profile
    )
    pending = chromium
      .launchPersistentContext(directory, {
        executablePath: process.env.CHROMIUM_PATH,
        headless: true,
        chromiumSandbox: true,
        // The worker closes contexts before exiting so profile writes finish.
        handleSIGINT: false,
        handleSIGTERM: false,
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 2,
        acceptDownloads: true,
        args: ["--disable-gpu", "--force-device-scale-factor=2"],
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([name, value]) => value !== undefined && !/proxy/i.test(name)
          )
        ),
      })
      .then(async (browser) => {
        browser.on("close", () => {
          if (contexts.get(key) === pending) contexts.delete(key)
          if (selected.incognito)
            void rm(directory, { recursive: true, force: true }).catch(() => {})
        })
        for (const page of browser.pages()) await page.close()
        return browser
      })
    contexts.set(key, pending)
    void pending.catch(() => {
      if (contexts.get(key) === pending) contexts.delete(key)
      if (selected.incognito) void rm(directory, { recursive: true, force: true }).catch(() => {})
    })
  }
  return pending
}

function state(tab: Tab): BrowserTab {
  return {
    id: tab.id,
    reveal: tab.reveal,
    cursor: tab.cursor,
    sessionId: tab.session,
    profileId: tab.profile,
    url: tab.page.url().startsWith("data:") ? "data:" : tab.page.url(),
    title: tab.title,
    owner: tab.control.viewer ? "human" : "agent",
    generation: tab.control.generation,
    loading: tab.loading,
    visible: tab.viewers.size > 0,
    openerTabId: tab.opener,
    width: tab.width,
    height: tab.height,
    zoom: tab.zoom,
    colorScheme: tab.colorScheme,
    recording: tab.recording !== null,
    fileChooser: tab.chooser !== null,
    dialog: tab.dialog
      ? {
          type: tab.dialog.type(),
          message: tab.dialog.message(),
          defaultValue: tab.dialog.defaultValue(),
        }
      : undefined,
    error: tab.error,
  }
}

function result(
  session: string,
  extra: Partial<BrowserResult> = {},
  caller = session
): BrowserResult {
  return {
    available: true,
    epoch,
    presets,
    tabs: [...tabs.values()]
      .filter((tab) => tab.session === session)
      .map((tab) => ({ ...state(tab), ownedByCaller: tab.caller === caller })),
    profiles: [...profiles.values()],
    defaultProfileId,
    downloads: [...artifacts.values()]
      .filter((file) => file.session === session)
      .map((file) => file.info),
    ...extra,
  }
}

function report(tab: Tab, kind: BrowserDiagnostic["kind"], text: string) {
  tab.diagnostics.push({
    kind,
    text: text.replace(/data:[^\s"'<>]+/g, "data:").slice(0, 2000),
    timestamp: new Date().toISOString(),
  })
  if (tab.diagnostics.length > 200) tab.diagnostics.shift()
}

async function artifact(tab: Tab, file: string, fileName: string, mimeType: string, bytes: number) {
  const id = randomUUID()
  const info: BrowserArtifact = {
    id,
    fileName,
    mimeType,
    sizeBytes: bytes,
    url: `?artifact=${id}`,
  }
  artifacts.set(id, { session: tab.session, path: file, info })
  while (artifacts.size > 100) {
    const first = artifacts.entries().next().value
    if (!first) break
    artifacts.delete(first[0])
    await rm(first[1].path, { force: true })
  }
  return info
}

async function attach(
  page: Page,
  session: string,
  profile: string,
  opener?: string,
  caller = session
) {
  if (tabs.size >= 32 || [...tabs.values()].filter((tab) => tab.caller === caller).length >= 8) {
    await page.close()
    throw new Error("Browser tab limit reached. Close a tab or reuse an existing tab.")
  }
  const tab: Tab = {
    id: randomUUID(),
    page,
    session,
    caller,
    profile,
    opener,
    cdp: await page.context().newCDPSession(page),
    control: new Control(),
    viewers: new Map(),
    refs: new Map(),
    diagnostics: [],
    dialog: null,
    chooser: null,
    recording: null,
    width: 1280,
    height: 800,
    zoom: 1,
    colorScheme: "system",
    used: Date.now(),
    title: "New tab",
    loading: false,
    snapshot: 0,
    cast: Promise.resolve(),
    castQuality: 0,
    frame: null,
    reveal: Date.now(),
    keys: new Set(),
    buttons: new Set(),
  }
  tabs.set(tab.id, tab)
  page.on("framenavigated", () => {
    tab.refs.clear()
    tab.chooser = null
    tab.snapshot++
  })
  page.on("framedetached", () => {
    tab.refs.clear()
    tab.snapshot++
  })
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) tab.loading = true
  })
  page.on("domcontentloaded", () => {
    tab.loading = false
    if (tab.zoom !== 1) void zoom(tab, tab.zoom).catch(() => {})
    void page
      .title()
      .then((title) => {
        tab.title = title
      })
      .catch(() => {})
  })
  page.on("load", () => {
    tab.loading = false
  })
  page.on("dialog", (dialog) => {
    tab.dialog = dialog
  })
  page.on("filechooser", (chooser) => {
    tab.chooser = chooser
  })
  page.on("console", (message) => report(tab, "console", message.text()))
  page.on("pageerror", (error) => report(tab, "console", error.message))
  page.on("requestfailed", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) tab.loading = false
    report(
      tab,
      "network",
      `${request.method()} ${request.url().split("?")[0]} ${request.failure()?.errorText}`
    )
  })
  page.on("response", (response) =>
    report(tab, "network", `${response.status()} ${response.url().split("?")[0]}`)
  )
  page.on("crash", () => {
    tab.error = "The browser page crashed. Reload to recover."
  })
  page.on("popup", (popup) => {
    void attach(popup, session, profile, tab.id, caller).catch(() => {})
  })
  page.on("close", () => {
    tabs.delete(tab.id)
    if (
      profiles.get(tab.profile)?.incognito &&
      ![...tabs.values()].some(
        (other) => other.session === tab.session && other.profile === tab.profile
      )
    ) {
      contexts.delete(`${tab.profile}:${tab.session}`)
      void page
        .context()
        .close()
        .catch(() => {})
    }
    for (const viewer of tab.viewers.values()) viewer.socket.close(4404, "Tab closed")
    void tab.control.close()
    if (tab.recording) void tab.recording.context.close()
  })
  page.on("download", (download) => {
    void (async () => {
      const file = join(scratch, randomUUID())
      await download.saveAs(file)
      const size = (await stat(file)).size
      if (size > 1024 ** 3) {
        await rm(file)
        return
      }
      await artifact(
        tab,
        file,
        basename(download.suggestedFilename()),
        "application/octet-stream",
        size
      )
    })().catch((error) => report(tab, "network", String(error)))
  })
  tab.cdp.on("Page.screencastFrame", (frame: { data: string; sessionId: number }) => {
    const data = Buffer.from(frame.data, "base64")
    tab.frame = data
    for (const viewer of tab.viewers.values()) {
      if (viewer.socket.readyState !== WebSocket.OPEN) continue
      if (viewer.socket.bufferedAmount > 8 * 1024 * 1024) {
        viewer.socket.close(4408, "Viewer is too slow")
        continue
      }
      if (viewer.inFlight) {
        viewer.pending = data
        continue
      }
      viewer.inFlight = true
      viewer.socket.send(data)
    }
    const recording = tab.recording
    if (recording && !recording.busy) {
      recording.busy = true
      recording.pending = recording.page
        .evaluate(({ data, width }) => window.__agentzRecorder.frame(data, width), {
          data: frame.data,
          width: tab.width,
        })
        .catch((error) => report(tab, "action", String(error)))
        .finally(() => {
          recording.busy = false
        })
    }
    void tab.cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {})
  })
  return tab
}

async function resetInput(tab: Tab) {
  for (const key of tab.keys) await tab.page.keyboard.up(key).catch(() => {})
  for (const button of tab.buttons) await tab.page.mouse.up({ button }).catch(() => {})
  tab.keys.clear()
  tab.buttons.clear()
}

async function zoom(tab: Tab, value: number) {
  // Page scale emulates pinch zoom and Chromium clamps zoom-out to 100%.
  // Document zoom also keeps input coordinates aligned with the screencast.
  await tab.page.evaluate((value) => {
    document.documentElement.style.zoom = value.toString()
  }, value)
}

async function screencast(tab: Tab) {
  tab.cast = tab.cast
    .catch(() => {})
    .then(async () => {
      const quality = tab.recording ? 90 : tab.viewers.size ? 70 : 0
      if (quality === tab.castQuality) return
      if (tab.castQuality) await tab.cdp.send("Page.stopScreencast")
      tab.castQuality = 0
      if (!quality) return
      await tab.cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality,
        maxWidth: 2560,
        maxHeight: 1600,
      })
      tab.castQuality = quality
    })
  await tab.cast
}

function target(tab: Tab, input: BrowserRequest) {
  if (input.locator?.startsWith("aria-ref=")) {
    const locator = tab.refs.get(input.locator.slice(9))
    if (!locator) throw new Error("Element reference is stale. Take a fresh snapshot.")
    return locator
  }
  const selector = input.locator ?? input.selector
  if (selector) return tab.page.locator(selector)
  return null
}

async function operate(
  session: string,
  input: BrowserRequest,
  viewer: string | null = null,
  signal?: AbortSignal,
  caller = session
): Promise<BrowserResult> {
  if (input.operation === "closeSession") {
    for (const tab of tabs.values())
      if (tab.session === session && (caller === session || tab.caller === caller))
        await tab.page.close()
    return result(session, {}, caller)
  }
  if (input.operation === "status" || input.operation === "profiles")
    return result(session, {}, caller)
  if (
    [
      "createProfile",
      "renameProfile",
      "setDefaultProfile",
      "deleteProfile",
      "clearProfile",
      "clearCookies",
      "clearCache",
    ].includes(input.operation)
  ) {
    return profileControl.run(null, async () => {
      const id =
        input.operation === "createProfile" ? randomUUID() : (input.profileId ?? defaultProfileId)
      if (input.operation !== "createProfile" && !profiles.has(id))
        throw new Error("Profile not found")
      switch (input.operation) {
        case "createProfile":
        case "renameProfile":
          if (!input.name?.trim()) throw new Error("Supply a profile name")
          if (["default", "incognito"].includes(id)) throw new Error("Choose a custom profile")
          if (input.operation === "createProfile" && profiles.size >= 24)
            throw new Error("At most 24 profiles are allowed")
          profiles.set(id, { id, name: input.name.trim(), incognito: false })
          break
        case "setDefaultProfile":
          defaultProfileId = id
          break
        case "clearCache": {
          const browser = await context(id, session)
          const existing = browser.pages()[0]
          const page = existing ?? (await browser.newPage())
          const cdp = await browser.newCDPSession(page)
          try {
            await cdp.send("Network.clearBrowserCache")
          } finally {
            await cdp.detach()
            if (!existing) await page.close()
          }
          return result(session, {}, caller)
        }
        case "clearCookies":
          await (await context(id, session)).clearCookies()
          return result(session, {}, caller)
        case "clearProfile":
        case "deleteProfile": {
          if (input.operation === "deleteProfile" && ["default", "incognito"].includes(id))
            throw new Error("Built-in profiles cannot be deleted")
          // Unopened profiles have no process to flush. Avoid launching
          // Chromium solely to close it before deleting the stored data.
          const key = profiles.get(id)?.incognito ? `${id}:${session}` : id
          await (await contexts.get(key))?.close()
          if (id !== "incognito") await rm(join(root, id), { recursive: true, force: true })
          if (input.operation === "clearProfile") return result(session, {}, caller)
          profiles.delete(id)
          if (defaultProfileId === id) defaultProfileId = "default"
          break
        }
      }
      await writeFile(
        profileFile + ".tmp",
        JSON.stringify({
          profiles: [...profiles.values()].filter(
            (profile) => profile.id !== "default" && !profile.incognito
          ),
          defaultProfileId,
        }),
        { mode: 0o600 }
      )
      await rename(profileFile + ".tmp", profileFile)
      return result(session, {}, caller)
    })
  }
  let tab = input.tabId
    ? tabs.get(input.tabId)
    : [...tabs.values()].find((tab) => tab.session === session && tab.caller === caller)
  if (input.operation === "open" && (!tab || input.reuseExistingTab === false)) {
    const profile = input.profileId ?? defaultProfileId
    tab = await attach(
      await (await context(profile, session)).newPage(),
      session,
      profile,
      undefined,
      caller
    )
    if (input.width && input.height) {
      if (input.width * input.height > 3840 * 2160) throw new Error("Viewport area is too large")
      await tab.page.setViewportSize({ width: input.width, height: input.height })
      tab.width = input.width
      tab.height = input.height
    }
    if (viewer) await tab.control.take(viewer)
    tab.reveal = input.open === false ? 0 : Date.now()
  }
  if (!tab || tab.session !== session) throw new Error("Browser tab not found for this session")
  const selected = tab
  if (input.operation === "open" && input.open !== false) selected.reveal = Date.now()
  selected.used = Date.now()
  if (input.operation === "takeControl") {
    if (!viewer) throw new Error("A human viewer is required")
    await selected.control.take(viewer)
    await resetInput(selected)
    selected.refs.clear()
    selected.snapshot++
    return result(session, { tabId: selected.id }, caller)
  }
  if (input.operation === "releaseControl") {
    if (!viewer) throw new Error("A human viewer is required")
    if (selected.control.viewer === viewer) await resetInput(selected)
    await selected.control.release(viewer)
    selected.refs.clear()
    selected.snapshot++
    return result(session, { tabId: selected.id }, caller)
  }
  const read = ["snapshot", "waitFor"].includes(input.operation)
  if (!read && !viewer && selected.caller !== caller)
    throw new Error("This tab belongs to another caller session")
  if (input.operation === "stopLoading") {
    if (selected.control.viewer !== viewer) throw new Error("Take control of this tab first")
    // A navigation owns the mutation queue until it finishes. Stopping it
    // must interrupt Chromium directly instead of waiting behind it.
    await selected.cdp.send("Page.stopLoading")
    selected.loading = false
    selected.stop?.()
    return result(session, { tabId: selected.id }, caller)
  }
  let running = false
  const run = async (): Promise<BrowserResult> => {
    running = true
    signal?.throwIfAborted()
    const page = selected.page
    const timeout = input.timeoutMs ?? 15000
    const deadline = Date.now() + timeout
    const locator = target(selected, input)
    page.setDefaultTimeout(timeout)
    if (input.operation === "snapshot" && selected.dialog)
      return result(session, { tabId: selected.id }, caller)
    report(selected, "action", input.operation)
    if (locator && ["click", "hover", "type"].includes(input.operation)) {
      const box = await locator.boundingBox()
      if (box)
        selected.cursor = {
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
          click: input.operation === "click",
        }
    }
    if (
      input.x !== undefined &&
      input.y !== undefined &&
      ["click", "hover"].includes(input.operation)
    ) {
      selected.cursor = { x: input.x, y: input.y, click: input.operation === "click" }
      if (selected.recording)
        await selected.recording.page.evaluate(
          (cursor) => window.__agentzRecorder.cursor(cursor.x, cursor.y, cursor.click),
          selected.cursor
        )
    }
    let extra: Partial<BrowserResult> = { tabId: selected.id }
    switch (input.operation) {
      case "open":
      case "navigate": {
        let address = input.url
        if (input.port)
          address = `${input.protocol ?? "http"}://localhost:${input.port}${input.path ?? "/"}`
        if (!address && input.operation === "open") break
        if (!address) throw new Error("Supply a URL or development server port")
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(address)) {
          const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(address)
          address = `${local ? "http" : "https"}://${address}`
        }
        const url = new URL(address)
        if (!["http:", "https:"].includes(url.protocol))
          throw new Error("Only HTTP and HTTPS navigation is supported")
        selected.refs.clear()
        await page.goto(url.href, { waitUntil: "domcontentloaded", timeout })
        selected.error = undefined
        break
      }
      case "close": {
        const lastIncognito =
          profiles.get(selected.profile)?.incognito && page.context().pages().length === 1
        await (lastIncognito ? page.context().close() : page.close())
        break
      }
      case "snapshot": {
        selected.refs.clear()
        const snapshot = ++selected.snapshot
        const generation = randomUUID()
        const trees: string[] = []
        const hidden = new Set<string>()
        for (const [frameIndex, frame] of page.frames().slice(0, 8).entries()) {
          if (snapshot !== selected.snapshot || Date.now() >= deadline)
            throw new Error("Snapshot interrupted. Take a fresh snapshot.")
          signal?.throwIfAborted()
          const passwords = await frame
            .locator("input,textarea,[contenteditable]")
            .evaluateAll((elements) =>
              elements.flatMap((element) => {
                const field =
                  element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
                const dots = getComputedStyle(element).getPropertyValue("-webkit-text-security")
                const password = element instanceof HTMLInputElement && element.type === "password"
                if (!password && (dots === "none" || dots === "")) return []
                const values = field
                  ? [element.value, element.defaultValue]
                  : [element.textContent ?? ""]
                return values
                  .flatMap((value) => [
                    value,
                    value
                      .replace(/[\u200b\u00ad]/g, "")
                      .trim()
                      .replace(/\s+/g, " "),
                  ])
                  .filter(Boolean)
              })
            )
          for (const value of passwords) {
            if (value.length > 64000) throw new Error("A password field cannot be safely masked")
            hidden.add(value)
          }
          trees.push(await frame.locator("body").ariaSnapshot({ timeout: Math.min(timeout, 3000) }))
          // Resolve visibility with Playwright, then label and tag the batch in
          // one renderer call. Per-element calls made large snapshots take seconds.
          const refs = await frame
            .locator("a,button,input,textarea,select,[role=button],[contenteditable=true]")
            .filter({ visible: true })
            .evaluateAll(
              (elements, prefix) =>
                elements.slice(0, 200).map((element, index) => {
                  const id = `${prefix}-${index}`
                  element.setAttribute("data-agentz-ref", id)
                  const label =
                    element.getAttribute("aria-label") ??
                    element.textContent?.slice(0, 120) ??
                    element.tagName
                  return { id, label }
                }),
              `${generation}-${frameIndex}`
            )
          if (snapshot !== selected.snapshot || Date.now() >= deadline)
            throw new Error("Snapshot interrupted. Take a fresh snapshot.")
          signal?.throwIfAborted()
          for (const { id, label } of refs) {
            selected.refs.set(id, frame.locator(`[data-agentz-ref="${id}"]`))
            trees.push(`[ref=${id}] ${label}`)
          }
        }
        if (snapshot !== selected.snapshot)
          throw new Error("Snapshot interrupted. Take a fresh snapshot.")
        let text = await page
          .locator("body")
          .innerText({ timeout: Math.max(1, deadline - Date.now()) })
        let tree = trees.join("\n")
        for (const value of [...hidden].sort((a, b) => b.length - a.length)) {
          text = text.split(value).join("••••••••")
          tree = tree.split(value).join("••••••••")
        }
        extra.visibleText = text.replace(/data:[^\s"'<>]+/g, "data:").slice(0, 20000)
        extra.accessibilityTree = tree.replace(/data:[^\s"'<>]+/g, "data:").slice(0, 20000)
        extra.diagnostics = selected.diagnostics.map((diagnostic) => {
          let text = diagnostic.text
          for (const value of hidden) text = text.split(value).join("••••••••")
          return { ...diagnostic, text }
        })
        extra.width = selected.width
        extra.height = selected.height
        if (input.includeImage || input.save) {
          const image = await page.screenshot({ type: "png", timeout: 3000 })
          if (input.includeImage) extra.screenshot = image.toString("base64")
          if (input.save) {
            const file = join(scratch, randomUUID())
            await writeFile(file, image)
            extra.artifact = await artifact(
              selected,
              file,
              "screenshot.png",
              "image/png",
              image.length
            )
          }
        }
        if (snapshot !== selected.snapshot)
          throw new Error("Snapshot interrupted. Take a fresh snapshot.")
        break
      }
      case "click":
        if (locator)
          await locator.click({
            button: input.button,
            clickCount: input.clickCount,
            timeout,
          })
        else if (input.x !== undefined && input.y !== undefined)
          await page.mouse.click(input.x, input.y, {
            button: input.button,
            clickCount: input.clickCount,
          })
        else throw new Error("Supply one locator or both coordinates")
        break
      case "hover":
        if (locator) await locator.hover({ timeout })
        else if (input.x !== undefined && input.y !== undefined)
          await page.mouse.move(input.x, input.y)
        else throw new Error("Supply one locator or both coordinates")
        break
      case "type":
        if (input.text === undefined) throw new Error("Text is required")
        if (locator) {
          if (input.clear) await locator.fill(input.text)
          else await locator.pressSequentially(input.text)
        } else {
          if (input.clear) await page.keyboard.press("ControlOrMeta+A")
          await page.keyboard.insertText(input.text)
        }
        break
      case "press":
        if (!input.key) throw new Error("Key is required")
        await page.keyboard.press([...(input.modifiers ?? []), input.key].join("+"))
        break
      case "scroll":
        if (locator)
          await locator.evaluate((element, delta) => element.scrollBy(delta.x, delta.y), {
            x: input.deltaX ?? 0,
            y: input.deltaY ?? 0,
          })
        else await page.mouse.wheel(input.deltaX ?? 0, input.deltaY ?? 0)
        break
      case "select":
        if (!locator || !input.values) throw new Error("A locator and values are required")
        extra.selected = await locator.selectOption(input.values)
        break
      case "drag": {
        const source = target(selected, { operation: "drag", locator: input.source })
        const destination = target(selected, { operation: "drag", locator: input.target })
        if (!source || !destination) throw new Error("Source and target locators are required")
        await source.dragTo(destination, { timeout })
        break
      }
      case "upload":
        if (input.paths?.length) throw new Error("Transfer upload bytes through the file endpoint")
        if (locator) await locator.setInputFiles([])
        else if (selected.chooser) await selected.chooser.setFiles([])
        selected.chooser = null
        break
      case "evaluate": {
        if (!input.expression) throw new Error("Expression is required")
        let evaluated = await selected.cdp.send("Runtime.evaluate", {
          expression: input.expression,
          awaitPromise: input.awaitPromise ?? true,
          returnByValue: input.returnByValue ?? true,
          timeout,
        })
        if (
          evaluated.exceptionDetails?.exception?.className === "SyntaxError" &&
          evaluated.exceptionDetails.scriptId !== undefined &&
          evaluated.exceptionDetails.stackTrace === undefined &&
          input.expression.includes("await")
        ) {
          evaluated = await selected.cdp.send("Runtime.evaluate", {
            expression: input.expression,
            awaitPromise: input.awaitPromise ?? true,
            returnByValue: input.returnByValue ?? true,
            replMode: true,
            timeout,
          })
        }
        if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text)
        const value: unknown =
          input.returnByValue === false
            ? { objectId: evaluated.result.objectId, description: evaluated.result.description }
            : evaluated.result.value
        if (Buffer.byteLength(JSON.stringify(value ?? null)) > 64000)
          throw new Error("Evaluation result exceeds 64 KB")
        extra.value = value ?? null
        break
      }
      case "waitFor": {
        if (!locator && !input.text && !input.urlIncludes)
          throw new Error("Supply at least one wait condition")
        const deadline = Date.now() + timeout
        for (;;) {
          const checks = await Promise.all([
            locator ? locator.count().then((count) => count > 0) : true,
            input.text
              ? page
                  .locator("body")
                  .innerText({ timeout: Math.min(timeout, 1000) })
                  .then((text) => text.includes(input.text ?? ""))
                  .catch(() => false)
              : true,
            !input.urlIncludes || page.url().includes(input.urlIncludes),
          ])
          if (checks.every(Boolean)) break
          if (Date.now() >= deadline)
            throw new Error("Timed out waiting for every browser condition")
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        break
      }
      case "dialog":
        if (!selected.dialog) throw new Error("No dialog is pending")
        if (input.accept) await selected.dialog.accept(input.promptText)
        else await selected.dialog.dismiss()
        selected.dialog = null
        selected.refs.clear()
        selected.snapshot++
        break
      case "resize": {
        let width = input.width ?? selected.width
        let height = input.height ?? selected.height
        if (input.mode === "preset") {
          const size = presets.find((preset) => preset.id === input.preset)
          if (!size) throw new Error("Unknown viewport preset")
          ;[width, height] = [size.width, size.height]
          const portrait = height >= width
          if (
            (input.orientation === "landscape" && portrait) ||
            (input.orientation === "portrait" && !portrait)
          )
            [width, height] = [height, width]
        }
        if (width * height > 3840 * 2160) throw new Error("Viewport area is too large")
        await page.setViewportSize({ width, height })
        selected.width = width
        selected.height = height
        if (input.zoom !== undefined) {
          await zoom(selected, input.zoom)
          selected.zoom = input.zoom
        }
        break
      }
      case "setColorScheme":
        selected.colorScheme = input.colorScheme ?? "system"
        await page.emulateMedia({
          colorScheme: selected.colorScheme === "system" ? null : selected.colorScheme,
        })
        break
      case "history":
        if (input.delta === -1) await page.goBack({ timeout })
        else await page.goForward({ timeout })
        break
      case "reload":
        if (input.ignoreCache)
          await selected.cdp.send("Network.setCacheDisabled", { cacheDisabled: true })
        try {
          await page.reload({ timeout, waitUntil: "domcontentloaded" })
        } finally {
          if (input.ignoreCache)
            await selected.cdp.send("Network.setCacheDisabled", { cacheDisabled: false })
        }
        break
      case "recordingStart": {
        if (selected.recording) throw new Error("Recording already running")
        const encoderContext = await context("incognito", `recording-${selected.id}`)
        const encoder = await encoderContext.newPage()
        try {
          await encoder.evaluate(recordingEncoderScript)
          const first = await page.screenshot({
            type: "jpeg",
            quality: 90,
            timeout: 3000,
          })
          await encoder.evaluate(({ data, width }) => window.__agentzRecorder.frame(data, width), {
            data: first.toString("base64"),
            width: selected.width,
          })
          selected.recording = {
            page: encoder,
            context: encoderContext,
            pending: Promise.resolve(),
            busy: false,
          }
          await screencast(selected)
        } catch (error) {
          selected.recording = null
          await encoderContext.close()
          throw error
        }
        break
      }
      case "recordingStop": {
        const recording = selected.recording
        if (!recording) throw new Error("No recording is running")
        selected.recording = null
        try {
          await recording.pending
          const stopped = await recording.page.evaluate(() => window.__agentzRecorder.stop())
          if (!stopped.mimeType || stopped.bytes > 50 * 1024 * 1024)
            throw new Error("Recording exceeds 50 MiB or produced no video")
          const chunks: Buffer[] = []
          for (let i = 0; i < stopped.count; i++)
            chunks.push(
              Buffer.from(
                await recording.page.evaluate((index) => window.__agentzRecorder.chunk(index), i),
                "base64"
              )
            )
          const file = join(scratch, randomUUID())
          const data = Buffer.concat(chunks)
          await writeFile(file, data)
          extra.artifact = await artifact(
            selected,
            file,
            stopped.mimeType.startsWith("video/mp4") ? "recording.mp4" : "recording.webm",
            stopped.mimeType,
            data.length
          )
        } finally {
          await recording.context.close()
          await screencast(selected)
        }
        break
      }
      default:
        throw new Error("Unsupported browser operation")
    }
    return result(session, extra, caller)
  }
  const interrupt = () => {
    if (!running) return
    selected.control.generation++
    selected.snapshot++
    selected.refs.clear()
    void selected.cdp.send("Page.stopLoading").catch(() => {})
    void selected.cdp.send("Runtime.terminateExecution").catch(() => {})
  }
  signal?.throwIfAborted()
  const budget = input.timeoutMs ?? (input.operation === "recordingStop" ? 120000 : 15000)
  const execute = async (): Promise<BrowserResult> => {
    if (selected.dialog && !["dialog", "snapshot", "close"].includes(input.operation))
      throw new Error("Answer the pending browser dialog first")
    let timer: ReturnType<typeof setTimeout> | undefined
    let onDialog: (() => void) | undefined
    let onAbort: (() => void) | undefined
    let stop: (() => void) | undefined
    const interrupted = new Promise<BrowserResult>((resolve, reject) => {
      if (["open", "navigate", "history", "reload"].includes(input.operation)) {
        stop = () => resolve(result(session, { tabId: selected.id }, caller))
        selected.stop = stop
      }
      timer = setTimeout(() => {
        interrupt()
        reject(new Error(`Browser operation timed out after ${budget}ms`))
      }, budget)
      onAbort = () => {
        interrupt()
        reject(new Error("Browser operation interrupted"))
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      if (["click", "press", "type", "evaluate"].includes(input.operation)) {
        onDialog = () => resolve(result(session, { tabId: selected.id }, caller))
        selected.page.once("dialog", onDialog)
      }
    })
    try {
      return await Promise.race([run(), interrupted])
    } finally {
      clearTimeout(timer)
      if (stop && selected.stop === stop) selected.stop = undefined
      if (onDialog) selected.page.off("dialog", onDialog)
      if (onAbort) signal?.removeEventListener("abort", onAbort)
    }
  }
  if (read) return execute()
  return selected.control.run(viewer, execute, Date.now() + budget)
}

const sockets = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 })
const server = createServer(async (req, res) => {
  const abort = new AbortController()
  res.once("close", () => {
    if (!res.writableEnded) abort.abort()
  })
  try {
    if (req.url === "/health" && req.socket.remoteAddress?.includes("127.0.0.1")) {
      await context("default", "health")
      res.end("ok")
      return
    }
    if (req.headers.origin || !authorized(req.headers.authorization, req.headers.host)) {
      res.writeHead(401).end()
      return
    }
    const url = new URL(req.url ?? "/", "http://browser")
    const session = url.searchParams.get("session")
    if (!session || session.length > 128) throw new Error("Session is required")
    const caller = req.headers["x-browser-caller"]
    if (Array.isArray(caller)) throw new Error("Invalid caller")
    const viewer = req.headers["x-browser-viewer"]
    if (Array.isArray(viewer)) throw new Error("Invalid viewer")
    const id = url.searchParams.get("artifact")
    if (req.method === "GET" && id) {
      const file = artifacts.get(id)
      if (!file || file.session !== session) {
        res.writeHead(404).end()
        return
      }
      res.setHeader("Content-Type", file.info.mimeType)
      res.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(file.info.fileName)}`
      )
      res.setHeader("Content-Length", file.info.sizeBytes)
      await pipeline(createReadStream(file.path), res)
      return
    }
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of req) {
      bytes += chunk.length
      if (bytes > 50 * 1024 * 1024) throw new Error("Request exceeds 50 MiB")
      chunks.push(chunk)
    }
    if (req.method === "PUT") {
      const tab = tabs.get(url.searchParams.get("tabId") ?? "")
      if (!tab || tab.session !== session) throw new Error("Tab not found")
      if (!viewer && tab.caller !== (caller ?? session))
        throw new Error("This tab belongs to another caller session")
      await tab.control.run(viewer ?? null, async () => {
        abort.signal.throwIfAborted()
        const files: Array<{ name: string; mimeType: string; buffer: Buffer }> = []
        const contentType = req.headers["content-type"] ?? "application/octet-stream"
        if (contentType.startsWith("multipart/form-data")) {
          const form = await new Response(Buffer.concat(chunks), {
            headers: { "content-type": contentType },
          }).formData()
          for (const entry of form.values()) {
            if (typeof entry === "string") throw new Error("Upload fields must be files")
            files.push({
              name: basename(entry.name),
              mimeType: entry.type,
              buffer: Buffer.from(await entry.arrayBuffer()),
            })
          }
        } else
          files.push({
            name: basename(url.searchParams.get("name") ?? "upload"),
            mimeType: contentType,
            buffer: Buffer.concat(chunks),
          })
        if (files.length > 20) throw new Error("At most 20 upload files are allowed")
        const locator = url.searchParams.get("locator")
        if (locator) {
          const input = target(tab, { operation: "upload", locator })
          if (!input) throw new Error("Upload target not found")
          await input.setInputFiles(files, { timeout: 15000 })
        } else if (tab.chooser) await tab.chooser.setFiles(files, { timeout: 15000 })
        else throw new Error("No file chooser is pending")
        tab.chooser = null
      })
      res.writeHead(204).end()
      return
    }
    if (req.method !== "POST") {
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify(result(session, {}, caller ?? session)))
      return
    }
    const input = zBrowserRequest.parse(JSON.parse(Buffer.concat(chunks).toString()))
    const response = await operate(session, input, viewer ?? null, abort.signal, caller ?? session)
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify(response))
  } catch (error) {
    if (res.destroyed || res.headersSent) return
    res.writeHead(409, { "Content-Type": "application/json" })
    res.end(
      JSON.stringify({
        code: "browser_error",
        message: error instanceof Error ? error.message : "Browser operation failed",
      })
    )
  }
})
server.on("upgrade", (req, socket, head) => {
  if (req.headers.origin || !authorized(req.headers.authorization, req.headers.host)) {
    socket.destroy()
    return
  }
  const url = new URL(req.url ?? "/", "http://browser")
  const tab = tabs.get(url.searchParams.get("tabId") ?? "")
  const viewer = req.headers["x-browser-viewer"]
  if (!tab || tab.session !== url.searchParams.get("session") || !viewer || Array.isArray(viewer)) {
    socket.destroy()
    return
  }
  sockets.handleUpgrade(req, socket, head, (ws) => {
    tab.viewers.get(viewer)?.socket.close(4409, "Viewer reconnected")
    tab.viewers.set(viewer, { socket: ws, inFlight: tab.frame !== null, pending: null })
    if (tab.frame) ws.send(tab.frame)
    let previous = ""
    let dragging = false
    let pendingMove: { input: BrowserInput; generation: number } | undefined
    const publish = () => {
      if (ws.readyState !== WebSocket.OPEN) return
      const message = JSON.stringify({
        type: "state",
        state: state(tab),
        canOperate: tab.control.viewer === viewer,
      })
      if (message === previous) return
      previous = message
      ws.send(message)
    }
    const status = setInterval(publish, 500)
    publish()
    void screencast(tab).catch(() => ws.close())
    ws.on("message", (data) => {
      void (async () => {
        let input = zBrowserInput.parse(JSON.parse(data.toString()))
        if (input.type === "ack") {
          const current = tab.viewers.get(viewer)
          if (!current) return
          current.inFlight = false
          if (current.pending) {
            const frame = current.pending
            current.pending = null
            current.inFlight = true
            ws.send(frame)
          }
          return
        }
        if (input.type !== "mouse" || input.action !== "move") pendingMove = undefined
        if (["takeControl", "releaseControl", "resetInput"].includes(input.type)) dragging = false
        if (input.type === "mouse" && input.action === "down") dragging = true
        if (input.type === "mouse" && input.action === "up") dragging = false
        if (input.type === "takeControl") {
          await tab.control.take(viewer)
          await resetInput(tab)
          tab.refs.clear()
          tab.snapshot++
          publish()
          return
        }
        if (input.type === "releaseControl") {
          if (tab.control.viewer === viewer) await resetInput(tab)
          await tab.control.release(viewer)
          tab.refs.clear()
          tab.snapshot++
          publish()
          return
        }
        if (tab.dialog) return
        const moving =
          input.type === "mouse" &&
          input.action === "move" &&
          input.x !== undefined &&
          input.y !== undefined &&
          !dragging &&
          !tab.buttons.size
        if (moving && pendingMove?.generation === tab.control.generation) {
          pendingMove.input = input
          return
        }
        const move = moving ? { input, generation: tab.control.generation } : undefined
        pendingMove = move
        await tab.control.run(viewer, async () => {
          // Keep the latest queued hover position. Buttons and keys fence the
          // batch, and dragging keeps every move so page gestures retain their path.
          if (move) {
            input = move.input
            if (pendingMove === move) pendingMove = undefined
          }
          if (tab.dialog) return
          const dialog = Promise.withResolvers<void>()
          const opened = () => dialog.resolve()
          tab.page.once("dialog", opened)
          const dispatch = async () => {
            tab.used = Date.now()
            if (input.type === "resetInput") {
              await resetInput(tab)
              return
            }
            if (input.type === "text" && input.text !== undefined) {
              await tab.page.keyboard.insertText(input.text)
              return
            }
            if (input.type === "key" && input.key) {
              if (input.action === "up") {
                await tab.page.keyboard.up(input.key)
                tab.keys.delete(input.key)
              } else {
                await tab.page.keyboard.down(input.key)
                tab.keys.add(input.key)
              }
              return
            }
            if (input.type === "wheel") {
              await tab.page.mouse.wheel(input.deltaX ?? 0, input.deltaY ?? 0)
              return
            }
            if (input.type === "mouse" && input.x !== undefined && input.y !== undefined) {
              tab.cursor = { x: input.x, y: input.y, click: input.action === "down" }
              if (tab.recording)
                void tab.recording.page
                  .evaluate(
                    ({ x, y, click }) => window.__agentzRecorder.cursor(x, y, click),
                    tab.cursor
                  )
                  .catch(() => {})
              await tab.page.mouse.move(input.x, input.y)
              if (input.action === "down") {
                await tab.page.mouse.down({ button: input.button, clickCount: input.clickCount })
                tab.buttons.add(input.button ?? "left")
              }
              if (input.action === "up") {
                await tab.page.mouse.up({ button: input.button, clickCount: input.clickCount })
                tab.buttons.delete(input.button ?? "left")
              }
            }
          }
          try {
            // Free the queue when input opens a modal so its answer can run.
            await Promise.race([dispatch(), dialog.promise])
          } finally {
            tab.page.off("dialog", opened)
          }
        })
      })().catch((error) => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(
            JSON.stringify({
              type: "error",
              message: error instanceof Error ? error.message : "Input failed",
            })
          )
      })
    })
    ws.on("close", () => {
      clearInterval(status)
      if (tab.viewers.get(viewer)?.socket !== ws) return
      tab.viewers.delete(viewer)
      if (tab.control.viewer === viewer) {
        tab.refs.clear()
        tab.snapshot++
        void resetInput(tab)
          .then(() => tab.control.release(viewer))
          .catch(() => {})
      }
      void screencast(tab).catch(() => {})
    })
  })
})
const cleanup = setInterval(() => {
  for (const tab of tabs.values())
    if (!tab.viewers.size && !tab.recording && Date.now() - tab.used > 30 * 60 * 1000)
      void tab.page.close()
}, 60000)
cleanup.unref()
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    server.close()
    void Promise.allSettled(
      [...contexts.values()].map(async (context) => (await context).close())
    ).finally(() => process.exit())
  })
await context("default", "startup")
server.listen(port, "0.0.0.0", () => console.log(`Browser worker ready on ${port}`))
