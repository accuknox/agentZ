import { agentForSkills } from "@/lib/skills/agent"
import { listImmutableSkills } from "@/lib/skills/gateway"
import { skillNamesSchema, streamImmutableSkillsZip, streamSkillsZip } from "@/lib/skills/storage"
import { tenantNamespaceForSkills } from "@/lib/skills/tenant"
import * as z from "zod"

const exportRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("mutable"),
    agentName: z.string().min(1, "agent is required"),
    skillNames: skillNamesSchema,
  }),
  z.object({
    type: z.literal("immutable"),
    skillNames: skillNamesSchema,
  }),
])

export async function POST(request: Request): Promise<Response> {
  const tenantNamespace = await tenantNamespaceForSkills()

  try {
    const parsed = exportRequestSchema.safeParse(await request.json())
    if (!parsed.success) {
      return Response.json(
        { error: parsed.error.issues[0]?.message ?? "invalid request" },
        { status: 400 }
      )
    }

    if (parsed.data.type === "mutable") {
      const agent = await agentForSkills(parsed.data.agentName)
      const body = await streamSkillsZip(agent.home_storage_prefix, parsed.data.skillNames)
      return zipResponse(body, mutableExportName(parsed.data.agentName, parsed.data.skillNames))
    }

    const requested = new Set(parsed.data.skillNames)
    const skills = (await listImmutableSkills())
      .filter((skill) => requested.has(skill.name))
      .map((skill) => ({ name: skill.name, version: skill.version }))
    if (skills.length !== requested.size) {
      throw new Error("skill not found")
    }
    const body = await streamImmutableSkillsZip(tenantNamespace, skills)
    return zipResponse(body, immutableExportName(parsed.data.skillNames))
  } catch (error) {
    const message = error instanceof Error ? error.message : "export skills failed"
    return Response.json({ error: message }, { status: 400 })
  }
}

function zipResponse(body: ReadableStream, filename: string): Response {
  return new Response(body, {
    headers: {
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Type": "application/zip",
    },
  })
}

function mutableExportName(agentName: string, skillNames: string[]): string {
  if (skillNames.length === 1) {
    return `${agentName}-${skillNames[0]}.zip`
  }
  return `${agentName}-${skillNames.length}x-skills.zip`
}

function immutableExportName(skillNames: string[]): string {
  if (skillNames.length === 1) {
    return `${skillNames[0]}.zip`
  }
  return `${skillNames.length}x-skills.zip`
}
