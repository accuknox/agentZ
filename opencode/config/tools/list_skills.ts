import { tool } from "@opencode-ai/plugin"
import path from "node:path"

import { listSkills } from "../lib/skills"

const description = `
List available skills.

Use this tool when you need the current skill names and descriptions before deciding whether to load or follow a skill.

This tool returns each skill's name, description, scope, and SKILL.md location. Use the skill tool to load the full instructions for a specific skill.

This tool takes no arguments.
`.trim()

export default tool({
  description,
  args: {},
  async execute(_, context) {
    const skills = await listSkills(context.directory, context.worktree)

    context.metadata({
      title: `Listed ${skills.length} skills`,
      metadata: {
        skill_count: skills.length,
        directory: context.directory,
        worktree: context.worktree,
      },
    })

    if (skills.length === 0) {
      return "No skills found in the configured skill roots."
    }

    return JSON.stringify(
      {
        skill_count: skills.length,
        skills: skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          scope: skill.scope,
          location: path.relative(skill.root, skill.location),
          root: skill.root,
        })),
      },
      null,
      2
    )
  },
})
