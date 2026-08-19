type ResourceLabel = {
  singular: string
  collection: string
  action?: string
}

export const resourceLabels = {
  mcp: {
    singular: "MCP connection",
    collection: "MCP connections",
    action: "Add MCP connection",
  },
  inference: {
    singular: "Inference provider",
    collection: "Inference providers",
    action: "Add inference provider",
  },
  skill: { singular: "Skill", collection: "Skills", action: "Import skills" },
  workflow: { singular: "Workflow", collection: "Workflows", action: "Add workflow" },
  mcpActivity: { singular: "MCP activity", collection: "MCP activity" },
} as const satisfies Record<string, ResourceLabel>
