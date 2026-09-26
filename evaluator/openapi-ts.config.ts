import { defineConfig } from "@hey-api/openapi-ts"

export default defineConfig({
  input: "../openapi/evaluator.yaml",
  output: "./client",
  plugins: ["@hey-api/typescript", "zod"],
})
