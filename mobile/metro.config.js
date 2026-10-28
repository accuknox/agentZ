const { getDefaultConfig } = require("expo/metro-config")
const { withUniwindConfig } = require("uniwind/metro")
const config = getDefaultConfig(__dirname)
config.maxWorkers = 2
config.resolver.assetExts.push("wasm")
config.server.enhanceMiddleware = (middleware) => (request, response, next) => {
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin")
  response.setHeader("Cross-Origin-Embedder-Policy", "credentialless")
  return middleware(request, response, next)
}
module.exports = withUniwindConfig(config, { cssEntryFile: "./global.css" })
