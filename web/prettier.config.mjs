/**
 * @see https://prettier.io/docs/configuration
 * @type {import("prettier").Config}
 */
const config = {
  trailingComma: "es5",
  tabWidth: 2,
  semi: false,
  printWidth: 100,
  tailwindStylesheet: "./app/globals.css",
  tailwindFunctions: ["cn", "cva"],
  plugins: ["prettier-plugin-tailwindcss"],
}

export default config
