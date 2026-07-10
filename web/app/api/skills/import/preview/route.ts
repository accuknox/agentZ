import { agentForSkills } from "@/lib/skills/agent"
import { listImmutableSkills } from "@/lib/skills/gateway"
import { jsonFormField, maxUploadBytes, skillsFromUpload } from "@/lib/skills/import"
import { listSkillNames } from "@/lib/skills/storage"
import { zAgentName } from "@/lib/gateway/client/zod.gen"
import * as z from "zod"

const previewRequestSchema = z.object({
  file: z.instanceof(File, { error: "import file is required" }),
  agents: jsonFormField(z.array(zAgentName).max(200, "Select at most 200 agents")),
})

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await request.formData()
    const options = previewRequestSchema.safeParse({
      file: form.get("file"),
      agents: form.get("agents") ?? "[]",
    })
    if (!options.success) {
      return Response.json(
        { error: options.error.issues[0]?.message ?? "invalid import options" },
        { status: 400 }
      )
    }
    if (options.data.file.size > maxUploadBytes) {
      return Response.json({ error: "import file is too large" }, { status: 400 })
    }

    const skills = await skillsFromUpload(
      options.data.file.name.toLowerCase(),
      Buffer.from(await options.data.file.arrayBuffer())
    )

    const [mutableByAgent, immutable] = await Promise.all([
      Promise.all(
        options.data.agents.map(async (agentName) => {
          const agent = await agentForSkills(agentName)
          return [agentName, await listSkillNames(agent.home_storage_prefix)] as const
        })
      ),
      listImmutableSkills(),
    ])

    const mutableAgentsBySkill = new Map<string, string[]>()
    for (const [agentName, names] of mutableByAgent) {
      for (const name of names) {
        mutableAgentsBySkill.set(name, [...(mutableAgentsBySkill.get(name) ?? []), agentName])
      }
    }
    const immutableExisting = new Set(immutable.map((skill) => skill.name))

    return Response.json({
      skills: skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        mutableConflictAgents: mutableAgentsBySkill.get(skill.name) ?? [],
        immutableConflict: immutableExisting.has(skill.name),
      })),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "preview import failed"
    return Response.json({ error: message }, { status: 400 })
  }
}
