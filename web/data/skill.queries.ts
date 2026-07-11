import { cacheLife, cacheTag } from "next/cache"
import type { Error, Skill } from "@/lib/gateway/client"
import { skillsTag } from "@/data/cache"
import { listImmutableSkills } from "@/lib/skills/gateway"

type ListImmutableSkillResponse =
  | {
      skills: Skill[]
      error: undefined
    }
  | {
      skills: undefined
      error: Error
    }

export async function listImmutableSkillsCachedQuery(): Promise<ListImmutableSkillResponse> {
  "use cache: private"

  cacheLife("minutes")
  cacheTag(skillsTag)

  try {
    return {
      skills: await listImmutableSkills(),
      error: undefined,
    }
  } catch (error) {
    return {
      skills: undefined,
      error: {
        code: "LIST_IMMUTABLE_SKILLS_FAILED",
        message: error instanceof globalThis.Error ? error.message : "Failed to load immutable skills",
      },
    }
  }
}
