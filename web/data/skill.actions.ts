"use server"

import { updateTag } from "next/cache"
import * as z from "zod"
import { createSkill, deleteSkill, updateAgent, updateSkill } from "@/lib/gateway/client"
import { zAgentName } from "@/lib/gateway/client/zod.gen"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { agentsTag, sandboxesTag, skillsTag } from "@/data/cache"
import type { SkillImportApplySkill, SkillImportPreview } from "@/data/types"
import { agentForSkills } from "@/lib/skills/agent"
import { listImmutableSkills } from "@/lib/skills/gateway"
import {
  importDecisionsSchema,
  jsonFormField,
  maxUploadBytes,
  skillsForApply,
  skillsFromUpload,
} from "@/lib/skills/import"
import {
  deleteImmutableSkillVersion,
  deleteSkillDirectories,
  immutableSkillStoragePath,
  listImmutableSkillVersions,
  listSkillNames,
  replaceSkills,
  skillNamesSchema,
  writeImmutableSkillVersion,
} from "@/lib/skills/storage"
import { tenantNamespaceForSkills } from "@/lib/skills/tenant"

type ActionResult = { error: string | undefined }

const agentsArraySchema = (min = 0) =>
  z
    .array(zAgentName, { error: "Agents must be a list" })
    .min(min, min === 0 ? undefined : "Select at least one agent")
    .max(200, "Select at most 200 agents")
    .refine((names) => new Set(names).size === names.length, "Agents must be unique")

const deleteSkillsInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("mutable"),
    agentName: zAgentName,
    skillNames: skillNamesSchema,
  }),
  z.object({
    type: z.literal("immutable"),
    skillNames: skillNamesSchema,
  }),
])

const updateSkillInputSchema = z.object({
  name: z.string({ error: "Skill name must be text" }).min(1, "Skill name is required"),
  version: z
    .number({ error: "Version must be a number" })
    .int("Version must be a whole number")
    .min(1, "Version must be at least 1"),
})

const importPreviewFormSchema = z.object({
  file: z.instanceof(File, { error: "Import file is required" }),
  agents: jsonFormField(agentsArraySchema()),
})

const importApplyFormSchema = z
  .object({
    file: z.instanceof(File, { error: "Import file is required" }),
    type: z.enum(["mutable", "immutable"], {
      error: "Type must be either 'mutable' or 'immutable'",
    }),
    agents: jsonFormField(agentsArraySchema()),
    decisions: jsonFormField(importDecisionsSchema),
  })
  .superRefine((value, ctx) => {
    if (value.type === "mutable" && value.agents.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "Select at least one agent",
        path: ["agents"],
      })
    }
  })

export async function deleteSkillsAction(
  input: z.input<typeof deleteSkillsInputSchema>
): Promise<ActionResult> {
  const parsed = deleteSkillsInputSchema.safeParse(input)
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid request" }
  }
  const data = parsed.data

  try {
    if (data.type === "mutable") {
      const agent = await agentForSkills(data.agentName)
      await deleteSkillDirectories(agent.home_storage_prefix, data.skillNames)
      return { error: undefined }
    }

    for (const skillName of data.skillNames) {
      const result = await deleteSkill({
        client: getGatewayServerClient(),
        path: { skillName },
      })
      if (result.error) {
        throw new Error(result.error.message)
      }
    }
    updateTag(agentsTag)
    updateTag(sandboxesTag)
    updateTag(skillsTag)
    return { error: undefined }
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to delete skills" }
  }
}

export async function updateSkillVersionAction(
  input: z.input<typeof updateSkillInputSchema>
): Promise<ActionResult> {
  const parsed = updateSkillInputSchema.safeParse(input)
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid request" }
  }
  const data = parsed.data

  const tenantNamespace = await tenantNamespaceForSkills()

  try {
    const versions = await listImmutableSkillVersions(tenantNamespace, data.name)
    if (!versions.includes(data.version)) {
      return { error: "Skill version not found" }
    }

    const result = await updateSkill({
      client: getGatewayServerClient(),
      path: { skillName: data.name },
      body: {
        version: data.version,
        storage_path: immutableSkillStoragePath(tenantNamespace, data.name, data.version),
      },
    })
    if (result.error) {
      throw new Error(result.error.message)
    }

    updateTag(skillsTag)
    return { error: undefined }
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to update skill" }
  }
}

export async function importPreviewAction(
  formData: FormData
): Promise<{ skills: SkillImportPreview[]; error: string | undefined }> {
  const parsed = importPreviewFormSchema.safeParse({
    file: formData.get("file"),
    agents: formData.get("agents") ?? "[]",
  })
  if (!parsed.success) {
    return { skills: [], error: parsed.error.issues[0]?.message ?? "Invalid import options" }
  }
  if (parsed.data.file.size > maxUploadBytes) {
    return { skills: [], error: "Import file is too large" }
  }

  await tenantNamespaceForSkills()

  try {
    const skills = await skillsFromUpload(
      parsed.data.file.name.toLowerCase(),
      Buffer.from(await parsed.data.file.arrayBuffer())
    )

    const [mutableByAgent, immutable] = await Promise.all([
      Promise.all(
        parsed.data.agents.map(async (agentName) => {
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

    return {
      skills: skills.map((skill) => ({
        name: skill.name,
        mutableConflictAgents: mutableAgentsBySkill.get(skill.name) ?? [],
        immutableConflict: immutableExisting.has(skill.name),
      })),
      error: undefined,
    }
  } catch (error) {
    return {
      skills: [],
      error: error instanceof Error ? error.message : "Failed to preview import",
    }
  }
}

export async function importApplyAction(
  formData: FormData
): Promise<{ skills: SkillImportApplySkill[]; error: string | undefined }> {
  const parsed = importApplyFormSchema.safeParse({
    file: formData.get("file"),
    type: formData.get("type"),
    agents: formData.get("agents"),
    decisions: formData.get("decisions"),
  })
  if (!parsed.success) {
    return { skills: [], error: parsed.error.issues[0]?.message ?? "Invalid import request" }
  }
  if (parsed.data.file.size > maxUploadBytes) {
    return { skills: [], error: "Import file is too large" }
  }

  const tenantNamespace = await tenantNamespaceForSkills()

  try {
    const skills = await skillsFromUpload(
      parsed.data.file.name.toLowerCase(),
      Buffer.from(await parsed.data.file.arrayBuffer())
    )
    const writes = skillsForApply(skills, parsed.data.decisions)
    const overwriteNames = new Set(
      parsed.data.decisions
        .filter((decision) => decision.action === "overwrite")
        .map((decision) => decision.name)
    )

    if (parsed.data.type === "mutable") {
      const agents = await Promise.all(parsed.data.agents.map((name) => agentForSkills(name)))
      await Promise.all(
        agents.map((agent) => replaceSkills(agent.home_storage_prefix, writes, overwriteNames))
      )
      updateTag(skillsTag)
      return {
        skills: writes.map((skill) => ({ name: skill.name })),
        error: undefined,
      }
    }

    const [existingSkills, agents] = await Promise.all([
      listImmutableSkills(),
      Promise.all(parsed.data.agents.map((name) => agentForSkills(name))),
    ])
    const existing = new Map(existingSkills.map((skill) => [skill.name, skill]))
    for (const skill of writes) {
      const current = existing.get(skill.name)
      const overwriting = overwriteNames.has(skill.name)
      if (current && !overwriting) {
        throw new Error(`Immutable skill ${skill.name} already exists`)
      }
      if (!current && overwriting) {
        throw new Error(`Immutable skill ${skill.name} does not exist`)
      }

      const versions = await listImmutableSkillVersions(tenantNamespace, skill.name)
      const latestVersion = Math.max(current?.version ?? 0, ...versions)
      const version = latestVersion + 1
      const storagePath = immutableSkillStoragePath(tenantNamespace, skill.name, version)
      await writeImmutableSkillVersion(tenantNamespace, skill, version)
      const result = current
        ? await updateSkill({
            client: getGatewayServerClient(),
            path: { skillName: skill.name },
            body: { description: skill.description, version, storage_path: storagePath },
          })
        : await createSkill({
            client: getGatewayServerClient(),
            body: {
              name: skill.name,
              description: skill.description,
              version,
              storage_path: storagePath,
            },
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

    const importedNames = writes.map((skill) => skill.name)
    for (const agent of agents) {
      const updatedSkills = [...new Set([...agent.skills, ...importedNames])].toSorted()
      if (updatedSkills.length === agent.skills.length) {
        continue
      }
      const result = await updateAgent({
        client: getGatewayServerClient(),
        path: { agentName: agent.name },
        body: { skills: updatedSkills },
      })
      if (result.error) {
        throw new Error(result.error.message)
      }
    }

    updateTag(agentsTag)
    updateTag(skillsTag)
    return {
      skills: writes.map((skill) => ({ name: skill.name })),
      error: undefined,
    }
  } catch (error) {
    return {
      skills: [],
      error: error instanceof Error ? error.message : "Failed to apply import",
    }
  }
}
