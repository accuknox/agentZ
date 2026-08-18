import { rootOrganizationPath } from "@/data/organizations"

export async function GET(): Promise<Response> {
  return new Response(null, {
    headers: { Location: await rootOrganizationPath() },
    status: 307,
  })
}
