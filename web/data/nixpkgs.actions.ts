"use server"

import * as z from "zod"
import type { Error as GatewayError } from "@/lib/gateway/client"

type SearchConfig = {
  esUrl: string
  esUsername: string
  esPassword: string
  indexAlias: string
}

const searchConfigEnvKeys = [
  "NIXOS_SEARCH_ES_URL",
  "NIXOS_SEARCH_ES_USERNAME",
  "NIXOS_SEARCH_ES_PASSWORD",
  "NIXOS_SEARCH_ES_SCHEMA_VERSION",
  "NIXOS_SEARCH_ES_BRANCH",
] as const

const nixPackageLicenseSchema = z
  .object({
    fullName: z.string().nullable().catch(null),
    url: z.string().nullable().catch(null),
  })
  .catch({
    fullName: null,
    url: null,
  })

const nixPackageMaintainerSchema = z
  .object({
    name: z.string().nullable().catch(null),
    email: z.string().nullable().catch(null),
    github: z.string().nullable().catch(null),
  })
  .catch({
    name: null,
    email: null,
    github: null,
  })

const nixPackageHomepageSchema = z
  .union([
    z.string().transform((value) => [value]),
    z.array(z.string()),
    z.null().transform(() => []),
  ])
  .catch([])

const nixPackageSchema = z.object({
  package_attr_name: z.string().catch(""),
  package_pname: z.string().catch(""),
  package_pversion: z.string().catch(""),
  package_description: z.string().nullable().catch(null),
  package_programs: z.array(z.string()).catch([]),
  package_license: z.array(nixPackageLicenseSchema).catch([]),
  package_homepage: nixPackageHomepageSchema,
  package_maintainers: z.array(nixPackageMaintainerSchema).catch([]),
})

const elasticsearchIndexNotFoundSchema = z.object({
  error: z.object({
    root_cause: z.array(z.object({ type: z.literal("index_not_found_exception") })).min(1),
  }),
})

const elasticsearchSearchResponseSchema = z.object({
  hits: z.object({
    hits: z.array(z.object({ _source: nixPackageSchema })),
  }),
})

export type NixPackage = z.infer<typeof nixPackageSchema>

export type SearchNixPackagesResponse =
  | { packages: NixPackage[]; error: undefined }
  | { packages: undefined; error: GatewayError }

function dashUnderscoreVariants(word: string): string[] {
  return [word.replace(/_/g, "-"), word.replace(/-/g, "_"), word]
}

function getSearchConfig(): SearchConfig {
  const missing = searchConfigEnvKeys.filter((key) => {
    const value = process.env[key]
    return value == null || value.trim() === ""
  })

  if (missing.length > 0) {
    throw new Error(`Missing required Elasticsearch env vars: ${missing.join(", ")}`)
  }

  const esUrl = process.env.NIXOS_SEARCH_ES_URL
  const esUsername = process.env.NIXOS_SEARCH_ES_USERNAME
  const esPassword = process.env.NIXOS_SEARCH_ES_PASSWORD
  const schemaVersion = process.env.NIXOS_SEARCH_ES_SCHEMA_VERSION
  const branch = process.env.NIXOS_SEARCH_ES_BRANCH

  if (
    esUrl == null ||
    esUsername == null ||
    esPassword == null ||
    schemaVersion == null ||
    branch == null
  ) {
    throw new Error("Elasticsearch env configuration disappeared during lookup")
  }

  // Upstream nixos-search rotates concrete indices and moves the stable
  // `latest-*` alias to the fresh index, so callers must always query alias.
  return {
    esUrl,
    esUsername,
    esPassword,
    indexAlias: `latest-${schemaVersion}-${branch}`,
  }
}

function isElasticsearchIndexNotFound(text: string): boolean {
  try {
    return elasticsearchIndexNotFoundSchema.safeParse(JSON.parse(text)).success
  } catch {
    return false
  }
}

function buildSearchBody(query: string, from = 0, size = 20): Record<string, unknown> {
  const rawWords = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  const positiveWords = rawWords.filter((w) => !w.startsWith("-"))
  const negativeWords = rawWords.filter((w) => w.startsWith("-")).map((w) => w.slice(1))

  const uniquePositiveVariants = [...new Set(positiveWords.flatMap(dashUnderscoreVariants))]
  const uniqueNegativeVariants = [...new Set(negativeWords.flatMap(dashUnderscoreVariants))]

  const fields = [
    "package_attr_name^9.0",
    "package_attr_name.*^5.4",
    "package_programs^9.0",
    "package_programs.*^5.4",
    "package_pname^6.0",
    "package_pname.*^3.6",
    "package_description^1.3",
    "package_description.*^0.78",
    "package_longDescription^1.0",
    "package_longDescription.*^0.6",
    "flake_name^0.5",
    "flake_name.*^0.3",
  ]

  return {
    from,
    size,
    query: {
      bool: {
        filter: [
          {
            term: {
              type: {
                value: "package",
              },
            },
          },
        ],
        must: [
          {
            dis_max: {
              tie_breaker: 0.7,
              queries: [
                {
                  multi_match: {
                    type: "cross_fields",
                    query: positiveWords.join(" "),
                    analyzer: "whitespace",
                    auto_generate_synonyms_phrase_query: false,
                    operator: "and",
                    fields,
                  },
                },
                ...uniquePositiveVariants.map((w) => ({
                  wildcard: {
                    package_attr_name: {
                      value: `*${w}*`,
                      case_insensitive: true,
                    },
                  },
                })),
              ],
            },
          },
        ],
        must_not:
          uniqueNegativeVariants.length > 0
            ? uniqueNegativeVariants.map((w) => ({
                wildcard: {
                  package_attr_name: {
                    value: `*${w}*`,
                    case_insensitive: true,
                  },
                },
              }))
            : undefined,
      },
    },
    sort: [{ _score: "desc" }, { package_attr_name: "asc" }, { package_pversion: "asc" }],
  }
}

export async function searchNixPackagesAction(
  query: string,
  from = 0,
  size = 20
): Promise<SearchNixPackagesResponse> {
  const searchConfig = getSearchConfig()
  const body = buildSearchBody(query, from, size)
  const auth = Buffer.from(`${searchConfig.esUsername}:${searchConfig.esPassword}`).toString(
    "base64"
  )

  try {
    const res = await fetch(`${searchConfig.esUrl}/${searchConfig.indexAlias}/_search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()

      return {
        packages: undefined,
        error: {
          code: `ES_${res.status}`,
          message: isElasticsearchIndexNotFound(text)
            ? `Elasticsearch alias not found: ${searchConfig.indexAlias}`
            : `Elasticsearch request failed with status ${res.status}`,
        },
      }
    }

    const parsed = elasticsearchSearchResponseSchema.safeParse(await res.json())
    const packages = parsed.success ? parsed.data.hits.hits.map((hit) => hit._source) : []

    return { packages, error: undefined }
  } catch (err) {
    return {
      packages: undefined,
      error: {
        code: "ES_NETWORK_ERROR",
        message: err instanceof Error ? err.message : "Network error reaching Elasticsearch",
      },
    }
  }
}
