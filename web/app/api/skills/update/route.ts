import { updateSkill } from "@/lib/gateway/client"
import { revalidateTag } from "next/cache"
import { skillsTag } from "@/data/cache"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import {
  immutableSkillStoragePath,
  skillNameSchema,
  skillVersionSchema,
} from "@/lib/skills/storage"
import { tenantNamespaceForSkills } from "@/lib/skills/tenant"
import * as z from "zod"

const updateRequestSchema = z.object({
  name: skillNameSchema,
  version: skillVersionSchema,
})

export async function POST(request: Request): Promise<Response> {
  try {
    const parsed = updateRequestSchema.safeParse(await request.json())
    if (!parsed.success) {
      return Response.json(
        { error: parsed.error.issues[0]?.message ?? "invalid request" },
        { status: 400 }
      )
    }

    const tenantNamespace = await tenantNamespaceForSkills()
    const body = {
      version: parsed.data.version,
      storage_path: immutableSkillStoragePath(
        tenantNamespace,
        parsed.data.name,
        parsed.data.version
      ),
    }
    const result = await updateSkill({
      client: getGatewayServerClient(),
      path: { skillName: parsed.data.name },
      body,
    })
    if (result.error) {
      throw new Error(result.error.message)
    }
    revalidateTag(skillsTag, "max")
    return Response.json({ skill: result.data })
  } catch (error) {
    const message = error instanceof Error ? error.message : "update skill failed"
    return Response.json({ error: message }, { status: 400 })
  }
}
