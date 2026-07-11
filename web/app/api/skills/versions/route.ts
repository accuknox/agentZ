import { NextRequest } from "next/server"
import { skillNameSchema, listImmutableSkillVersions } from "@/lib/skills/storage"
import { tenantNamespaceForSkills } from "@/lib/skills/tenant"
import * as z from "zod"

const versionsQuerySchema = z.object({
  skill_name: skillNameSchema,
})

export async function GET(request: NextRequest): Promise<Response> {
  const tenantNamespace = await tenantNamespaceForSkills()

  try {
    const { skill_name: skillName } = versionsQuerySchema.parse({
      skill_name: request.nextUrl.searchParams.get("skill_name") ?? undefined,
    })
    const versions = await listImmutableSkillVersions(tenantNamespace, skillName)
    return Response.json({ versions })
  } catch (error) {
    const message = error instanceof Error ? error.message : "list skill versions failed"
    return Response.json({ error: message }, { status: 400 })
  }
}
