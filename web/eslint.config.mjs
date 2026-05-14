import { defineConfig, globalIgnores } from "eslint/config"
import nextVitals from "eslint-config-next/core-web-vitals"
import prettier from "eslint-config-prettier/flat"
import pluginQuery from "@tanstack/eslint-plugin-query"

const eslintConfig = defineConfig([
  ...nextVitals,
  prettier,
  ...pluginQuery.configs["flat/recommended-strict"],
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".ref/**",
  ]),
])

export default eslintConfig
