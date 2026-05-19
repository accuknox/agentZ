"use server"

import type { Error } from "@/lib/gateway/client"

const esUrl =
  process.env.NIXOS_SEARCH_ES_URL ?? "https://nixos-search-7-1733963800.us-east-1.bonsaisearch.net"
const esUsername = process.env.NIXOS_SEARCH_ES_USERNAME ?? "aWVSALXpZv"
const esPassword = process.env.NIXOS_SEARCH_ES_PASSWORD ?? "X8gPHnzL52wFEekuxsfQ9cSh"
const index = "nixos-48-25.11-d7a713c0b7e47c908258e71cba7a2d77cc8d71d5"

export type NixPackageLicense = {
  fullName: string | null
  url: string | null
}

export type NixPackageMaintainer = {
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

function buildSearchBody(query: string, from = 0, size = 20): Record<string, unknown> {
  const rawWords = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  const positiveWords = rawWords.filter((w) => !w.startsWith("-"))
  const negativeWords = rawWords.filter((w) => w.startsWith("-")).map((w) => w.slice(1))

  const positiveVariants = positiveWords.flatMap(dashUnderscoreVariants)
  const uniquePositiveVariants = [...new Set(positiveVariants)]

  const negativeVariants = negativeWords.flatMap(dashUnderscoreVariants)
  const uniqueNegativeVariants = [...new Set(negativeVariants)]

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
  const body = buildSearchBody(query, from, size)
  const auth = Buffer.from(`${esUsername}:${esPassword}`).toString("base64")

  try {
    const res = await fetch(`${esUrl}/${index}/_search`, {
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
          message: `Elasticsearch request failed: ${text.slice(0, 200)}`,
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
