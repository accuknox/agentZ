import { NextRequest } from "next/server"
import * as z from "zod"
import { listSkills as listGatewaySkills } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { zAgentName } from "@/lib/gateway/client/zod.gen"
import { agentForSkills } from "@/lib/skills/agent"
import { immutableSkillSummary, listSkillPage } from "@/lib/skills/storage"
import { tenantNamespaceForSkills } from "@/lib/skills/tenant"

const listSkillsQuerySchema = z.object({
  type: z.enum(["mutable", "immutable"]),
  agent_name: zAgentName.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  page_token: z.string().min(1).optional(),
})

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const parsed = listSkillsQuerySchema.safeParse({
      type: request.nextUrl.searchParams.get("type") ?? undefined,
      agent_name: request.nextUrl.searchParams.get("agent_name") ?? undefined,
      limit: request.nextUrl.searchParams.get("limit") ?? undefined,
      page_token: request.nextUrl.searchParams.get("page_token") ?? undefined,
    })
    if (!parsed.success) {
      return Response.json(
        { error: parsed.error.issues[0]?.message ?? "invalid request" },
        { status: 400 }
      )
    }

    const tenantNamespace = await tenantNamespaceForSkills()

    if (parsed.data.type === "mutable") {
      if (!parsed.data.agent_name) {
        return Response.json({ error: "agent is required" }, { status: 400 })
      }
      const agent = await agentForSkills(parsed.data.agent_name)
      const page = await listSkillPage(agent.home_storage_prefix, {
        limit: parsed.data.limit,
        pageToken: parsed.data.page_token,
      })
      return Response.json({
        ...page,
        skills: page.skills.map((skill) => ({ ...skill, type: "mutable" as const })),
      })
    }

    const result = await listGatewaySkills({
      client: getGatewayServerClient(),
      query: {
        agent_name: parsed.data.agent_name,
        limit: parsed.data.limit,
        page_token: parsed.data.page_token,
      },
    })
    if (result.error) {
      throw new Error(result.error.message)
    }

    const skills = await Promise.all(
      result.data.skills.map(async (skill) => {
        const summary = await immutableSkillSummary(tenantNamespace, skill.name, skill.version)
        return {
          ...summary,
          type: "immutable" as const,
          version: skill.version,
          agents: skill.agents,
          sandboxes: skill.sandboxes,
        }
      })
    )

    return Response.json({
      skills,
      nextPageToken: result.data.next_page_token,
      hasNextPage: Boolean(result.data.next_page_token),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "list skills failed"
    return Response.json({ error: message }, { status: 400 })
  }
}
