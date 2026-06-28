export const defaultEnvironmentPackages = [
  "gnused",
  "gawk",
  "gnugrep",
	"bc",
  "jq",
  "yq-go",
  "curl",
  "mcporter",
] as const

export const defaultEnvironmentPackageSet = new Set<string>(defaultEnvironmentPackages)
