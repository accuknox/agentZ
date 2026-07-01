export const defaultSandboxPackages = [
  "gnused",
  "gawk",
  "gnugrep",
  "bc",
  "jq",
  "yq-go",
  "curl",
  "mcporter",
] as const

export const defaultSandboxPackageSet = new Set<string>(defaultSandboxPackages)
