import type { NextConfig } from "next"

const authURL = process.env.BETTER_AUTH_URL

const nextConfig: NextConfig = {
  ...(authURL ? { allowedDevOrigins: [new URL(authURL).hostname] } : {}),
  cacheComponents: true,
  images: {
    maximumDiskCacheSize: 50_000_000,
    maximumRedirects: 0,
    maximumResponseBody: 1_000_000,
    remotePatterns: [
      {
        hostname: "avatars.githubusercontent.com",
        pathname: "/u/**",
        port: "",
        protocol: "https",
        search: "?v=4",
      },
      new URL("https://lh3.googleusercontent.com/a/**"),
    ],
  },
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
