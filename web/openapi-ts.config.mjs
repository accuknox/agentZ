/** @type {import('@hey-api/openapi-ts').UserConfig} */
const config = {
  input: "../api/openapi.base.yaml",
  output: {
    path: "lib/gateway/client",
    postProcess: ["eslint", "prettier"],
    tsConfigPath: "tsconfig.json",
  },
  plugins: [
    {
      name: "@hey-api/sdk",
      operations: {
        strategy: "flat",
      },
      validator: {
        request: "zod",
      },
    },
    "zod",
    { name: "@hey-api/client-next", runtimeConfigPath: "@/lib/gateway/hey-api" },
    "@tanstack/react-query",
  ],
}

export default config
