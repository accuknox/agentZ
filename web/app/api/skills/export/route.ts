import { agentForSkills } from "@/lib/skills/agent"
import { skillNamesSchema, streamSkillsZip } from "@/lib/skills/storage"
import * as z from "zod"

const exportRequestSchema = z.object({
  agentName: z.string().min(1),
  skillNames: skillNamesSchema,
})

export async function POST(request: Request): Promise<Response> {
  try {
    const parsed = exportRequestSchema.safeParse(await request.json())
    if (!parsed.success) {
      return Response.json(
        { error: parsed.error.issues[0]?.message ?? "invalid request" },
        { status: 400 }
      )
    }

    const agent = await agentForSkills(parsed.data.agentName)
    const body = await streamSkillsZip(agent.home_storage_prefix, parsed.data.skillNames)
    return new Response(body, {
      headers: {
        "Content-Disposition": `attachment; filename="${parsed.data.agentName}-skills.zip"`,
        "Content-Type": "application/zip",
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "export skills failed"
    return Response.json({ error: message }, { status: 400 })
  }
}
