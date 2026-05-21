import { fileURLToPath } from "node:url";

/** @type {import('@hey-api/openapi-ts').UserConfig} */
const config = {
  input: fileURLToPath(new URL("../../api/openapi.base.yaml", import.meta.url)),
  output: {
    path: fileURLToPath(new URL("./lib/gateway/client", import.meta.url)),
    postProcess: ["prettier"],
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
    {
      name: "@hey-api/client-fetch",
      baseUrl: "http://localhost",
    },
  ],
};

export default config;
