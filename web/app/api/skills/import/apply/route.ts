import { createSkill, updateSkill, type Skill } from "@/lib/gateway/client"
import { revalidateTag } from "next/cache"
import { agentsTag, skillsTag } from "@/data/cache"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { agentForSkills } from "@/lib/skills/agent"
import { listImmutableSkills } from "@/lib/skills/gateway"
import {
  importDecisionsSchema,
  jsonFormField,
  maxUploadBytes,
  skillsForApply,
  skillsFromUpload,
} from "@/lib/skills/import"
import { tenantNamespaceForSkills } from "@/lib/skills/tenant"
import {
  deleteImmutableSkillVersion,
  replaceSkills,
  writeImmutableSkillVersion,
} from "@/lib/skills/storage"
import { zAgentName } from "@/lib/gateway/client/zod.gen"
import * as z from "zod"

const applyImportSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("mutable"),
    agents: jsonFormField(z.array(zAgentName).min(1, "Select at least one agent")),
  }),
  z.object({
    type: z.literal("immutable"),
    agents: jsonFormField(z.array(zAgentName)),
  }),
])

const applyFormSchema = z.object({
  file: z.instanceof(File, { error: "import file is required" }),
  decisions: jsonFormField(importDecisionsSchema),
  type: z.enum(["mutable", "immutable"]),
  agents: z.string(),
})

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await request.formData()
    const fields = applyFormSchema.safeParse({
      file: form.get("file"),
      decisions: form.get("decisions"),
      type: form.get("type"),
      agents: form.get("agents"),
    })
    if (!fields.success) {
      return Response.json(
        { error: fields.error.issues[0]?.message ?? "import request is invalid" },
        { status: 400 }
      )
    }
    if (fields.data.file.size > maxUploadBytes) {
      return Response.json({ error: "import file is too large" }, { status: 400 })
    }

    const options = applyImportSchema.safeParse({
      type: fields.data.type,
      agents: fields.data.agents,
    })
    if (!options.success) {
      return Response.json(
        { error: options.error.issues[0]?.message ?? "invalid import options" },
        { status: 400 }
      )
    }

    const skills = await skillsFromUpload(
      fields.data.file.name.toLowerCase(),
      Buffer.from(await fields.data.file.arrayBuffer())
    )
    const writes = skillsForApply(skills, fields.data.decisions)
    const overwriteNames = new Set(
      fields.data.decisions
        .filter((decision) => decision.action === "overwrite")
        .map((decision) => decision.name)
    )

    if (options.data.type === "mutable") {
      const agents = await Promise.all(options.data.agents.map((name) => agentForSkills(name)))
      await Promise.all(
        agents.map((agent) => replaceSkills(agent.home_storage_prefix, writes, overwriteNames))
      )
      return Response.json({
        skills: writes.map((skill) => ({ name: skill.name })),
      })
    }

    const tenantNamespace = await tenantNamespaceForSkills()
    const existing = await immutableSkillsByName()
    for (const skill of writes) {
      const current = existing.get(skill.name)
      const overwriting = overwriteNames.has(skill.name)
      if (current && !overwriting) {
        throw new Error(`immutable skill ${skill.name} already exists`)
      }
      if (!current && overwriting) {
        throw new Error(`immutable skill ${skill.name} does not exist`)
      }

      const version = current ? current.version + 1 : 1
      const storagePath = await writeImmutableSkillVersion(tenantNamespace, skill, version)
      const body = {
        description: skill.description,
        version,
        storage_path: storagePath,
        agents: options.data.agents,
      }
      const result = current
        ? await updateSkill({
            client: getGatewayServerClient(),
            path: { skillName: skill.name },
            body,
          })
        : await createSkill({
            client: getGatewayServerClient(),
            body: { name: skill.name, ...body },
          })
      if (result.error) {
        try {
          await deleteImmutableSkillVersion(tenantNamespace, skill.name, version)
        } catch (cleanupError) {
          const cleanupMessage =
            cleanupError instanceof Error ? cleanupError.message : "cleanup failed"
          throw new Error(`${result.error.message}; ${cleanupMessage}`)
        }
        throw new Error(result.error.message)
      }
    }

    revalidateTag(agentsTag, "max")
    revalidateTag(skillsTag, "max")
    return Response.json({
      skills: writes.map((skill) => ({ name: skill.name })),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "apply import failed"
    return Response.json({ error: message }, { status: 400 })
  }
}

async function immutableSkillsByName(): Promise<Map<string, Skill>> {
  return new Map((await listImmutableSkills()).map((skill) => [skill.name, skill]))
}
