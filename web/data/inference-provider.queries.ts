import { cacheLife, cacheTag } from "next/cache"
import {
  listInferenceProviders,
  type Error as GatewayError,
  type InferenceProvider,
} from "@/lib/gateway/client"
import { inferenceProvidersTag } from "@/data/cache"
import { getGatewayServerClient } from "@/lib/gateway/server-client"

export type InferenceProvidersResult =
  | {
      providers: InferenceProvider[]
      error: undefined
    }
  | {
      providers: undefined
      error: GatewayError
    }

export async function listInferenceProvidersCachedQuery(): Promise<InferenceProvidersResult> {
  "use cache: private"

  cacheLife("minutes")
  cacheTag(inferenceProvidersTag)

  const providers: InferenceProvider[] = []
  let pageToken: string | undefined
  do {
    const { data, error } = await listInferenceProviders({
      query: { limit: 200, page_token: pageToken },
      client: getGatewayServerClient(),
    })
    if (error) {
      return { providers: undefined, error }
    }
    providers.push(...data.providers)
    pageToken = data.next_page_token || undefined
  } while (pageToken)
  return {
    providers,
    error: undefined,
  }
}
