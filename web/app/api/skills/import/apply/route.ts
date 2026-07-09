import { agentForSkills } from "@/lib/skills/agent"
import {
  importDecisionsSchema,
  maxUploadBytes,
  skillsForApply,
  skillsFromUpload,
} from "@/lib/skills/import"
import { replaceSkills } from "@/lib/skills/storage"

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await request.formData()
    const agentName = form.get("agentName")
    const file = form.get("file")
    const decisionsValue = form.get("decisions")
    if (
      typeof agentName !== "string" ||
      !(file instanceof File) ||
      typeof decisionsValue !== "string"
    ) {
      return Response.json({ error: "import request is invalid" }, { status: 400 })
    }
    if (file.size > maxUploadBytes) {
      return Response.json({ error: "import file is too large" }, { status: 400 })
    }

    const decisions = importDecisionsSchema.safeParse(JSON.parse(decisionsValue))
    if (!decisions.success) {
      return Response.json(
        { error: decisions.error.issues[0]?.message ?? "invalid import decisions" },
        { status: 400 }
      )
    }

    const [agent, skills] = await Promise.all([
      agentForSkills(agentName),
      skillsFromUpload(file.name.toLowerCase(), Buffer.from(await file.arrayBuffer())),
    ])
    const writes = skillsForApply(skills, decisions.data)
    const overwriteNames = new Set(
      decisions.data
        .filter((decision) => decision.action === "overwrite")
        .map((decision) => decision.name)
    )

    await replaceSkills(agent.home_storage_prefix, writes, overwriteNames)
    return Response.json({
      skills: writes.map((skill) => ({ name: skill.name })),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "apply import failed"
    return Response.json({ error: message }, { status: 400 })
  }
}
