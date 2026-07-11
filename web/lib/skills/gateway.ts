import "server-only"

import { listSkills, type Skill } from "@/lib/gateway/client"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export async function listImmutableSkills(agentName?: string): Promise<Skill[]> {
  const skills: Skill[] = []
  let pageToken = ""

  for (;;) {
    const result = await listSkills({
      client: getGatewayServerClient(),
      query: {
        agent_name: agentName,
        limit: 200,
        page_token: pageToken || undefined,
      },
    })
    if (result.error) {
      throw new Error(result.error.message)
    }

    skills.push(...result.data.skills)
    pageToken = result.data.next_page_token
    if (pageToken.length === 0) {
      return skills
    }
  }
}
