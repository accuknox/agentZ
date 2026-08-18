import type { NextConfig } from "next"

const authURL = process.env.BETTER_AUTH_URL

const nextConfig: NextConfig = {
  ...(authURL ? { allowedDevOrigins: [new URL(authURL).hostname] } : {}),
  cacheComponents: true,
  output: "standalone",
  outputFileTracingIncludes: {
    "/*": ["node_modules/@img/sharp-libvips-*/lib/**/*"],
  },
  reactCompiler: true,
  typedRoutes: true,
  experimental: {
    turbopackFileSystemCacheForDev: false,
    serverActions: {
      bodySizeLimit: "11mb",
    },
  },
}

export default nextConfig
