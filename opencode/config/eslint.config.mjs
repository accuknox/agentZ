import { defineConfig } from "eslint/config"
import prettier from "eslint-config-prettier/flat"
import tseslint from "typescript-eslint"

const eslintConfig = defineConfig([
  tseslint.configs.recommended,
  {
    files: ["lib/gateway/client/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
    },
  },
  prettier,
])

export default eslintConfig
