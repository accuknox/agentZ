import type { NextConfig } from "next"

// In prod, the cluster's ingress fronts gateway traffic at the shared origin,
// so Next must not rewrite anything. In dev, next (3000) and the gateway (8090)
// are separate processes, so proxy the gateway-owned /api/* prefixes to the
// gateway's internal address. Prefixes come from the generated gateway and
// opencode SDKs; Next-owned route handlers (api/gateway/token, api/auth/*) are
// deliberately absent from this list so they keep being served by Next.
async function rewrites() {
  if (process.env.NODE_ENV === "production") return []
  const target = process.env.GATEWAY_INTERNAL_BASE_URL?.trim().replace(/\/$/, "")
  if (!target) return []
  // /api/<prefix>:path* matches both the root and any nested segment, so one
  // rule per gateway namespace is enough.
  const prefixes = [
    "opencode/:agent/:path*",
    "tenant/:path*",
    "agent/:path*",
    "lens/:path*",
    "secret/:path*",
    "environment/:path*",
    "mcp-connection/:path*",
    "workflow/:path*",
  ]
  return prefixes.map((p) => ({
    source: `/api/${p}`,
    destination: `${target}/api/${p}`,
  }))
}

const nextConfig: NextConfig = {
  cacheComponents: true,
  output: "standalone",
  reactCompiler: true,
  rewrites,
}

export default nextConfig
