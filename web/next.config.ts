import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  cacheComponents: true,
  output: "standalone",
  reactCompiler: true,
}

export default nextConfig
