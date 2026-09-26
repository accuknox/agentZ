import { createServer } from "node:http"
import { assertions } from "promptfoo"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { zGradeRequest } from "./client/zod.gen"
import type { EvaluationGradeResult } from "./client/types.gen"

// This service shares the gateway's pod network and only accepts loopback traffic.
// The gateway supplies the authorized agent target; browsers cannot submit grades.
const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(204).end()
    return
  }
  if (request.method !== "POST" || request.url !== "/grade") {
    response.writeHead(404).end()
    return
  }
  const abort = new AbortController()
  response.on("close", () => abort.abort())
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(35_000)])
  const chunks: Buffer[] = []
  let length = 0
  try {
    for await (const chunk of request) {
      length += chunk.length
      if (length > 8 * 1024 * 1024) {
        response.writeHead(413).end()
        return
      }
      chunks.push(chunk)
    }
    const input = zGradeRequest.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")))
    const result: EvaluationGradeResult = {
      checks: [],
      quality: 1,
      tokens: 0,
      cost: 0,
    }
    if (input.expected !== "") {
      const check = await assertions.runAssertion({
        assertion: { type: "equals", value: input.expected.trim() },
        providerResponse: { output: input.output.trim() },
        test: {},
      })
      result.checks.push({
        name: "Expected output",
        passed: check.pass,
        score: check.score,
        reason: check.reason,
      })
      result.quality = check.score
    }
    const judge = input.policy.judge
    if (input.policy.rubric && judge) {
      const client = createOpencodeClient({
        baseUrl: input.target,
        throwOnError: true,
      })
      const session = await client.session.create(
        {
          title: "Evaluation judge",
          permission: [{ permission: "*", pattern: "*", action: "deny" }],
        },
        { signal }
      )
      if (!session.data) throw new Error("Judge session was not created")
      const sessionID = session.data.id
      try {
        const provider = {
          id: () => `agentz:${judge.provider_id}/${judge.model_id}`,
          callApi: async (prompt: string) => {
            const reply = await client.session.prompt(
              {
                sessionID,
                model: {
                  providerID: judge.provider_id,
                  modelID: judge.model_id,
                },
                variant: judge.variant,
                parts: [{ type: "text", text: prompt }],
              },
              { signal }
            )
            if (!reply.data || reply.data.info.error) throw new Error("Judge execution failed")
            const usage = reply.data.info.tokens
            result.tokens +=
              usage.input + usage.output + usage.reasoning + usage.cache.read + usage.cache.write
            result.cost += reply.data.info.cost
            return {
              output: reply.data.parts
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n"),
            }
          },
        }
        const check = await assertions.runAssertion({
          assertion: {
            type: "llm-rubric",
            value: input.policy.rubric,
            threshold: input.policy.minimum_quality,
          },
          providerResponse: { output: input.output },
          test: { options: { provider } },
        })
        if (check.metadata?.graderError === true) throw new Error(check.reason)
        result.checks.push({
          name: "Quality rubric",
          passed: check.pass,
          score: check.score,
          reason: check.reason,
        })
        result.quality = Math.min(result.quality, check.score)
      } finally {
        await client.session.abort({ sessionID }, { signal: AbortSignal.timeout(5_000) })
        await client.session.delete({ sessionID }, { signal: AbortSignal.timeout(5_000) })
      }
    }
    if (!result.checks.length) throw new Error("At least one grading check is required")
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result))
  } catch (error) {
    response.writeHead(422, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        message: error instanceof Error ? error.message : "Grading failed",
      })
    )
  }
})
server.requestTimeout = 45_000
server.listen(8091, "127.0.0.1")
process.on("SIGTERM", () => server.close())
