import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tool, type Plugin } from "@opencode-ai/plugin"
import { z } from "zod"
import { zAgentTool } from "../lib/gateway/client/zod.gen"

const interpreters = {
  bash: { command: "bash", filename: "tool.sh" },
  python: { command: "python3", filename: "tool.py" },
  node: { command: "node", filename: "tool.js" },
}

export default (async () => {
  const manifest = process.env.AGENTZ_TOOLS_PATH
  if (!manifest) return { tool: {} }

  // The mounted manifest is external input. Validate it with the generated
  // contract rather than importing uploaded source into the plugin process.
  const definitions = z.array(zAgentTool).parse(JSON.parse(await readFile(manifest, "utf8")))
  const tools = definitions.map((def) => {
    const args: z.ZodRawShape = Object.fromEntries(
      def.inputs.map((input) => {
        let schema: z.ZodType
        switch (input.type) {
          case "string":
            schema = tool.schema.string()
            break
          case "number":
            schema = tool.schema.number()
            break
          case "integer":
            schema = tool.schema.int()
            break
          case "boolean":
            schema = tool.schema.boolean()
            break
          case "json":
            schema = tool.schema.json()
            break
        }
        if (!input.required) schema = schema.optional()
        return [input.name, schema.describe(input.description)]
      })
    )
    const parameters = tool.schema.strictObject(args)

    return [
      def.name,
      tool({
        description: def.description,
        args,
        async execute(input, context) {
          const values = parameters.parse(input)
          context.abort.throwIfAborted()
          await context.ask({
            permission: def.name,
            patterns: ["*"],
            always: ["*"],
            metadata: { language: def.language, filename: def.filename },
          })
          context.abort.throwIfAborted()

          const dir = await mkdtemp(join(tmpdir(), "agentz-tool-"))
          const runtime = interpreters[def.language]
          const file = join(dir, runtime.filename)
          const started = Date.now()
          try {
            await writeFile(file, def.script, { mode: 0o600 })
            context.abort.throwIfAborted()
            const child = spawn(runtime.command, [file], {
              cwd: context.directory,
              env: process.env,
              detached: true,
              stdio: ["pipe", "pipe", "pipe"],
            })
            const stdout: Buffer[] = []
            const stderr: Buffer[] = []
            let bytes = 0
            let failure: Error | undefined

            function stop() {
              // Signal the whole group so descendants cannot retain output
              // pipes or continue using the agent after cancellation.
              const pid = child.pid
              if (pid === undefined) return
              try {
                process.kill(-pid, "SIGKILL")
              } catch {
                // An exited process group has nothing left to signal.
              }
            }

            const cancel = () => {
              failure ??= new Error("Tool execution cancelled")
              stop()
            }
            context.abort.addEventListener("abort", cancel, { once: true })
            try {
              const code = await new Promise<number | null>((resolve, reject) => {
                for (const [stream, chunks] of [
                  [child.stdout, stdout],
                  [child.stderr, stderr],
                ] as const) {
                  stream.on("data", (chunk: Buffer) => {
                    bytes += chunk.length
                    if (bytes <= 64 * 1024) {
                      chunks.push(chunk)
                      return
                    }
                    failure ??= new Error("Tool output exceeded 64 KiB")
                    stop()
                  })
                }
                child.once("error", reject)
                // A child can retain inherited pipes after its parent exits.
                // End the invocation's process group before waiting for close.
                child.once("exit", stop)
                child.once("close", resolve)
                child.stdin.on("error", (error: NodeJS.ErrnoException) => {
                  // Scripts may exit without reading stdin. Their exit status
                  // determines success; an early closed pipe must not crash OpenCode.
                  if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") {
                    failure ??= error
                    stop()
                  }
                })
                child.stdin.end(JSON.stringify(values))
                if (context.abort.aborted) cancel()
              })
              const output = Buffer.concat(stdout).toString("utf8")
              const diagnostic = Buffer.concat(stderr).toString("utf8")
              if (failure) throw failure
              if (code !== 0) {
                throw new Error(`Tool exited with status ${code}\n${diagnostic || output}`)
              }
              return {
                title: def.name,
                output,
                metadata: { exitCode: code, durationMs: Date.now() - started, stderr: diagnostic },
              }
            } finally {
              context.abort.removeEventListener("abort", cancel)
              // Successful scripts may leave background children. They belong
              // to this invocation and must not outlive its temporary source.
              stop()
            }
          } finally {
            await rm(dir, { recursive: true, force: true })
          }
        },
      }),
    ] as const
  })
  return { tool: Object.fromEntries(tools) }
}) satisfies Plugin
