export default {
  input: "../openapi/base.yaml",
  parser: {
    filters: {
      // The operation filter still resolves parameters on unselected path items.
      orphans: true,
      operations: {
        include: [
          "POST /api/mobile/pairing/{id}",
          "POST /api/mobile/token",
          "DELETE /api/mobile/token",
          "POST /api/chat-session/{agentName}/{sessionId}/input",
          "GET /api/chat-session/{agentName}/{sessionId}/input",
          "PATCH /api/chat-session/{agentName}/{sessionId}/input/{inputId}",
          "GET /api/workflow/{agentName}/schedule",
        ],
      },
    },
  },
  output: { path: "gateway", tsConfigPath: "tsconfig.json" },
  plugins: [
    "@hey-api/typescript",
    { name: "@hey-api/sdk", operations: { strategy: "flat" } },
    "@hey-api/client-fetch",
    { name: "zod", compatibilityVersion: "mini", requests: false },
  ],
}
