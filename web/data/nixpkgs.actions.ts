"use server"

import type { Error } from "@/lib/gateway/client"

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

type NixPackageLicense = {
  fullName: string | null
  url: string | null
}

type NixPackageMaintainer = {
  name: string | null
  email: string | null
  github: string | null
}

export type NixPackage = {
  package_attr_name: string
  package_pname: string
  package_pversion: string
  package_description: string | null
  package_programs: string[]
  package_license: NixPackageLicense[]
  package_homepage: string[]
  package_maintainers: NixPackageMaintainer[]
}

export type SearchNixPackagesResponse =
  | { packages: NixPackage[]; error: undefined }
  | { packages: undefined; error: Error }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

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
  let payload: unknown

  try {
    payload = JSON.parse(text)
  } catch {
    return false
  }

  if (!isRecord(payload) || !isRecord(payload.error)) {
    return false
  }

  const rootCause = payload.error.root_cause

  if (!Array.isArray(rootCause) || rootCause.length === 0) {
    return false
  }

  const firstCause = rootCause[0]

  if (!isRecord(firstCause) || typeof firstCause.type !== "string") {
    return false
  }

  return firstCause.type === "index_not_found_exception"
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
    sort: [
      { _score: "desc" as const },
      { package_attr_name: "asc" as const },
      { package_pversion: "asc" as const },
    ],
  }
}

function parseMaintainer(raw: unknown): NixPackageMaintainer {
  if (!isRecord(raw)) {
    return {
      name: null,
      email: null,
      github: null,
    }
  }

  return {
    name: typeof raw.name === "string" ? raw.name : null,
    email: typeof raw.email === "string" ? raw.email : null,
    github: typeof raw.github === "string" ? raw.github : null,
  }
}

function parseLicense(raw: unknown): NixPackageLicense {
  if (!isRecord(raw)) {
    return {
      fullName: null,
      url: null,
    }
  }

  return {
    fullName: typeof raw.fullName === "string" ? raw.fullName : null,
    url: typeof raw.url === "string" ? raw.url : null,
  }
}

function parseHomepage(raw: unknown): string[] {
  if (raw === null) return []
  if (typeof raw === "string") return [raw]
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === "string")
  return []
}

function parsePackage(source: unknown): NixPackage {
  if (!isRecord(source)) {
    return {
      package_attr_name: "",
      package_pname: "",
      package_pversion: "",
      package_description: null,
      package_programs: [],
      package_license: [],
      package_homepage: [],
      package_maintainers: [],
    }
  }

  return {
    package_attr_name: String(source.package_attr_name ?? ""),
    package_pname: String(source.package_pname ?? ""),
    package_pversion: String(source.package_pversion ?? ""),
    package_description:
      source.package_description != null ? String(source.package_description) : null,
    package_programs: Array.isArray(source.package_programs)
      ? source.package_programs.filter((p): p is string => typeof p === "string")
      : [],
    package_license: Array.isArray(source.package_license)
      ? source.package_license.map(parseLicense)
      : [],
    package_homepage: parseHomepage(source.package_homepage),
    package_maintainers: Array.isArray(source.package_maintainers)
      ? source.package_maintainers.map(parseMaintainer)
      : [],
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

    const json = await res.json()
    const hits =
      isRecord(json) && isRecord(json.hits) && Array.isArray(json.hits.hits) ? json.hits.hits : []
    const packages = hits.flatMap((hit) => {
      if (!isRecord(hit)) return []
      return [parsePackage(hit._source)]
    })

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
