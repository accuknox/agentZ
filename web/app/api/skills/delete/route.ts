import { deleteSkill } from "@/lib/gateway/client"
import { revalidateTag } from "next/cache"
import { agentsTag, sandboxesTag, skillsTag } from "@/data/cache"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { agentForSkills } from "@/lib/skills/agent"
import { deleteSkillDirectories } from "@/lib/skills/storage"
import * as z from "zod"

const deleteRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("mutable"),
    agentName: z.string().min(1, "agent is required"),
    skillNames: z.array(z.string()).min(1, "Select at least one skill"),
  }),
  z.object({
    type: z.literal("immutable"),
    skillNames: z.array(z.string()).min(1, "Select at least one skill"),
  }),
])

export async function POST(request: Request): Promise<Response> {
  try {
    const parsed = deleteRequestSchema.safeParse(await request.json())
    if (!parsed.success) {
      return Response.json(
        { error: parsed.error.issues[0]?.message ?? "invalid request" },
        { status: 400 }
      )
    }

    if (parsed.data.type === "mutable") {
      const agent = await agentForSkills(parsed.data.agentName)
      await deleteSkillDirectories(agent.home_storage_prefix, parsed.data.skillNames)
      return Response.json({ deleted: parsed.data.skillNames })
    }

    for (const skillName of parsed.data.skillNames) {
      const result = await deleteSkill({
        client: getGatewayServerClient(),
        path: { skillName },
      })
      if (result.error) {
        throw new Error(result.error.message)
      }
    }
    revalidateTag(agentsTag, "max")
    revalidateTag(sandboxesTag, "max")
    revalidateTag(skillsTag, "max")
    return Response.json({ deleted: parsed.data.skillNames })
  } catch (error) {
    const message = error instanceof Error ? error.message : "delete skills failed"
    return Response.json({ error: message }, { status: 400 })
  }
}
