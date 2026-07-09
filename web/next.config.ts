import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  cacheComponents: true,
  output: "standalone",
  reactCompiler: true,
  typedRoutes: true,
  experimental: {
    turbopackFileSystemCacheForDev: false,
  },
}

export default nextConfig
