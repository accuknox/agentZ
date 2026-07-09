import { agentForSkills } from "@/lib/skills/agent"
import { maxUploadBytes, skillsFromUpload } from "@/lib/skills/import"
import { listSkillNames } from "@/lib/skills/storage"

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await request.formData()
    const agentName = form.get("agentName")
    const file = form.get("file")
    if (typeof agentName !== "string" || !(file instanceof File)) {
      return Response.json({ error: "import file is required" }, { status: 400 })
    }
    if (file.size > maxUploadBytes) {
      return Response.json({ error: "import file is too large" }, { status: 400 })
    }

    const [agent, skills] = await Promise.all([
      agentForSkills(agentName),
      skillsFromUpload(file.name.toLowerCase(), Buffer.from(await file.arrayBuffer())),
    ])
    const existing = new Set(await listSkillNames(agent.home_storage_prefix))

    return Response.json({
      skills: skills.map((skill) => ({
        name: skill.name,
        conflict: existing.has(skill.name),
      })),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "preview import failed"
    return Response.json({ error: message }, { status: 400 })
  }
}
