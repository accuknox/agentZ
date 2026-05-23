import { defineConfig } from "eslint/config"
import prettier from "eslint-config-prettier/flat"
import tseslint from "typescript-eslint"

const eslintConfig = defineConfig([
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
    },
  },
  prettier,
])

export default eslintConfig
