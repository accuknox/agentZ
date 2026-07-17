import { cacheLife, cacheTag } from "next/cache"
import { listSkills, type Error, type Skill } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"
import { skillsTag } from "@/data/cache"

type ListImmutableSkillResponse =
  | { skills: Skill[]; error: undefined }
  | { skills: undefined; error: Error }

export async function listImmutableSkillsCachedQuery(): Promise<ListImmutableSkillResponse> {
  "use cache: private"

  cacheLife("minutes")
  cacheTag(skillsTag)

  const skills: Skill[] = []
  let pageToken = ""
  for (;;) {
    const result = await listSkills({
      client: getGatewayServerClient(),
      query: { limit: 200, page_token: pageToken || undefined },
    })
    if (result.error) {
      return { skills: undefined, error: result.error }
    }
    skills.push(...result.data.skills)
    pageToken = result.data.next_page_token
    if (!pageToken) {
      return { skills, error: undefined }
    }
  }
}
