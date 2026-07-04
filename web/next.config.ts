import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  cacheComponents: true,
  output: "standalone",
  reactCompiler: true,
  typedRoutes: true,
}

export default nextConfig
