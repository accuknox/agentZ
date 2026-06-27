import { tool } from "@opencode-ai/plugin"

import { listSkillFiles, listSkills } from "../lib/skills"

const fileLimit = 10

const description = [
  "Load a specialized skill when the task at hand matches one of the available skills.",
  "",
  "Use a name returned by list_skills.",
].join("\n")

export default tool({
  description,
  args: {
    name: tool.schema.string().min(1).describe("The name of the skill from list_skills."),
  },
  async execute(args, context) {
    const skills = await listSkills(context.directory, context.worktree)
    const skill = skills.find((item) => item.name === args.name)

    if (!skill) {
      const available = skills.map((item) => item.name)
      context.metadata({
        title: `Unable to load skill: ${args.name}`,
        metadata: {
          requested_skill: args.name,
          available_skills: available,
        },
      })

      if (available.length === 0) {
        return `Skill "${args.name}" not found. No skills are currently available.`
      }

      return `Skill "${args.name}" not found. Available skills: ${available.join(", ")}`
    }

    await context.ask({
      permission: "skill",
      patterns: [skill.name],
      always: [skill.name],
      metadata: {},
    })

    const files = await listSkillFiles(skill.baseDir, fileLimit)

    context.metadata({
      title: `Loaded skill: ${skill.name}`,
      metadata: {
        name: skill.name,
        dir: skill.baseDir,
        scope: skill.scope,
        root: skill.root,
      },
    })

    return [
      `<skill_content name="${skill.name}">`,
      `# Skill: ${skill.name}`,
      "",
      skill.content.trim(),
      "",
      `Base directory for this skill: ${skill.baseDir}`,
      "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
      "Note: file list is sampled.",
      "",
      "<skill_files>",
      ...files.map((file) => `<file>${file}</file>`),
      "</skill_files>",
      "</skill_content>",
    ].join("\n")
  },
})
