import { agentForSkills } from "@/lib/skills/agent"
import { deleteSkills, skillNamesSchema } from "@/lib/skills/storage"
import * as z from "zod"

const deleteRequestSchema = z.object({
  agentName: z.string().min(1),
  skillNames: skillNamesSchema,
})

export async function POST(request: Request): Promise<Response> {
  try {
    const parsed = deleteRequestSchema.safeParse(await request.json())
    if (!parsed.success) {
      return Response.json(
        { error: parsed.error.issues[0]?.message ?? "invalid request" },
        { status: 400 }
      )
    }

    const agent = await agentForSkills(parsed.data.agentName)
    await deleteSkills(agent.home_storage_prefix, parsed.data.skillNames)
    return Response.json({ deleted: parsed.data.skillNames })
  } catch (error) {
    const message = error instanceof Error ? error.message : "delete skills failed"
    return Response.json({ error: message }, { status: 400 })
  }
}
