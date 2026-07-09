import { NextRequest } from "next/server"
import * as z from "zod"
import { agentForSkills } from "@/lib/skills/agent"
import { listSkillPage } from "@/lib/skills/storage"

const listSkillsQuerySchema = z.object({
  agent_name: z.string().min(1),
  limit: z.string().regex(/^\d+$/).optional(),
  page_token: z.string().min(1).optional(),
})

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const parsed = listSkillsQuerySchema.safeParse({
      agent_name: request.nextUrl.searchParams.get("agent_name"),
      limit: request.nextUrl.searchParams.get("limit") ?? undefined,
      page_token: request.nextUrl.searchParams.get("page_token") ?? undefined,
    })
    if (!parsed.success) {
      return Response.json(
        { error: parsed.error.issues[0]?.message ?? "invalid request" },
        { status: 400 }
      )
    }

    const agent = await agentForSkills(parsed.data.agent_name)
    const page = await listSkillPage(agent.home_storage_prefix, {
      limit: parsed.data.limit ? Number(parsed.data.limit) : undefined,
      pageToken: parsed.data.page_token,
    })
    return Response.json(page)
  } catch (error) {
    const message = error instanceof Error ? error.message : "list skills failed"
    return Response.json({ error: message }, { status: 400 })
  }
}
