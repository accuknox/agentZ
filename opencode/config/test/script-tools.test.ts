import { after as afterAll, before as beforeAll, test } from "node:test"
import assert from "node:assert/strict"
import { setTimeout } from "node:timers/promises"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"
import type { AgentTool } from "../lib/gateway/client/types.gen"
import plugin from "../plugins/script-tools"

let dir: string
const previous = process.env.AGENTZ_TOOLS_PATH

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentz-tool-test-"))
  process.env.AGENTZ_TOOLS_PATH = join(dir, "tools.json")
})

afterAll(async () => {
  if (previous === undefined) delete process.env.AGENTZ_TOOLS_PATH
  else process.env.AGENTZ_TOOLS_PATH = previous
  await rm(dir, { recursive: true, force: true })
})

function context(abort = new AbortController().signal): ToolContext {
  return {
    agent: "general",
    sessionID: "test",
    messageID: "test",
    directory: dir,
    worktree: dir,
    abort,
    metadata() {},
    async ask() {},
  }
}

async function registered(
  language: AgentTool["language"],
  script: string,
  inputs: AgentTool["inputs"] = []
) {
  const filename = { bash: "tool.sh", python: "tool.py", node: "tool.js" }[language]
  const definition: AgentTool = {
    name: "example",
    description: "Test uploaded scripts",
    filename,
    language,
    script,
    inputs,
  }
  await writeFile(process.env.AGENTZ_TOOLS_PATH ?? "", JSON.stringify([definition]))
  const [entry] = Object.values((await plugin()).tool)
  if (!entry) throw new Error("tool was not registered")
  return entry
}

test("all interpreters receive literal JSON stdin and the session directory", async () => {
  const args = { text: "$(touch injected); `echo hacked` ' \\\n雪", count: 2 }
  const inputs: AgentTool["inputs"] = [
    { name: "text", description: "Text", type: "string", required: true },
    { name: "count", description: "Count", type: "integer", required: true },
  ]
  const scripts: Record<AgentTool["language"], string> = {
    bash: "pwd >&2; cat",
    python: "import sys, os\nprint(os.getcwd(), file=sys.stderr)\nprint(sys.stdin.read(), end='')",
    node: "const fs = require('node:fs'); console.error(process.cwd()); process.stdout.write(fs.readFileSync(0, 'utf8'))",
  }
  for (const language of ["bash", "python", "node"] as const) {
    const entry = await registered(language, scripts[language], inputs)
    const result = await entry.execute(args, context())
    assert.partialDeepStrictEqual(result, {
      output: JSON.stringify(args),
      metadata: { stderr: dir + "\n" },
    })
  }
  await assert.rejects(access(join(dir, "injected")))
})

test("argument validation runs before spawning and accepts optional JSON", async () => {
  const entry = await registered("bash", "cat", [
    { name: "count", description: "Count", type: "integer", required: true },
    { name: "extra", description: "Nested data", type: "json", required: false },
  ])
  await assert.rejects(entry.execute({ count: "1" }, context()))
  await assert.rejects(entry.execute({ count: 1.5 }, context()))
  await assert.rejects(entry.execute({ count: 1, unknown: true }, context()))
  const result = await entry.execute({ count: 1, extra: { list: [true, null, "text"] } }, context())
  assert.partialDeepStrictEqual(result, {
    output: JSON.stringify({ count: 1, extra: { list: [true, null, "text"] } }),
  })
})

test("zero-input tools receive an empty object and stderr failures are bounded", async () => {
  const entry = await registered("bash", "cat")
  assert.partialDeepStrictEqual(await entry.execute({}, context()), { output: "{}" })
  const failing = await registered("bash", "echo diagnostic >&2; exit 7")
  await assert.rejects(failing.execute({}, context()), /status 7\ndiagnostic/)
})

test("permission denial prevents script execution", async () => {
  const entry = await registered("bash", "touch denied")
  const ctx = context()
  ctx.ask = async () => {
    throw new Error("permission denied")
  }
  await assert.rejects(entry.execute({}, ctx), /permission denied/)
  await assert.rejects(access(join(dir, "denied")))
})

test("combined output overflow terminates an invocation", async () => {
  const entry = await registered(
    "python",
    "import sys\nsys.stdout.write('x' * 40000)\nsys.stderr.write('x' * 40000)"
  )
  await assert.rejects(entry.execute({}, context()), /64 KiB/)
})

test("cancellation stops a script and its background child", async () => {
  const pidfile = join(dir, "child.pid")
  const entry = await registered("bash", `sleep 120 &\necho $! > '${pidfile}'\nwait`)
  const controller = new AbortController()
  const executing = entry.execute({}, context(controller.signal))
  const assertion = assert.rejects(executing, /cancelled/)
  for (let i = 0; i < 100; i++) {
    try {
      await access(pidfile)
      break
    } catch {
      await setTimeout(10)
    }
  }
  const pid = parseInt(await readFile(pidfile, "utf8"), 10)
  controller.abort()
  await assertion
  // The kernel may briefly retain a killed orphan as a zombie; its state must
  // never be sleeping/running after the invocation returns.
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8")
    assert.ok(stat.split(") ")[1]?.startsWith("Z"))
  } catch {
    await assert.rejects(access(`/proc/${pid}/stat`))
  }
})

test("already cancelled invocations never execute", async () => {
  const entry = await registered("bash", "touch cancelled")
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(entry.execute({}, context(controller.signal)))
  await assert.rejects(access(join(dir, "cancelled")))
})

test("successful scripts cannot leave descendants holding output pipes", async () => {
  const entry = await registered("bash", "sleep 120 &\nprintf done")
  assert.partialDeepStrictEqual(await entry.execute({}, context()), { output: "done" })
})
