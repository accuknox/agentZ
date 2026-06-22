import { tool } from "@opencode-ai/plugin"

import { getWorkflow, type Workflow, type WorkflowEdge, type WorkflowNode } from "../lib/gateway"
import { zError } from "../lib/gateway"
import { workflowAgentName, workflowErrorOutput } from "../lib/workflow"

const getWorkflowArgs = {
  workflow_name: tool.schema
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
    .describe("Stable DNS-label workflow identifier, for example triage-review"),
}

const description = `
Retrieve a reusable workflow DAG as a detailed execution playbook in markdown.

Use this tool when you need the saved workflow's definition. Prefer this tool over reconstructing or guessing workflow details from memory.

The tool returns:

- workflow metadata and summary
- declared workflow inputs
- start and terminal nodes
- nodes in execution order
- complete node instructions, goals, done criteria, and preferred tools
- incoming and outgoing transitions for each node
- branch labels and condition summaries for every edge

Example, if the user asks "Use the repo-triage workflow", call this tool with workflow_name "repo-triage"
`.trim()

export default tool({
  description,
  args: getWorkflowArgs,
  async execute(args, context) {
    const agentName = workflowAgentName()
    if (!agentName) {
      context.metadata({
        title: "Workflow retrieval unavailable",
        metadata: { reason: "missing_agent_name" },
      })
      return "CLAWARMOR_AGENT_NAME is not set. Configure the agent runtime before using get_workflow."
    }

    context.metadata({
      title: `Get workflow ${args.workflow_name}`,
      metadata: {
        agent_name: agentName,
        workflow_name: args.workflow_name,
      },
    })

    const result = await getWorkflow({
      path: {
        agentName,
        workflowName: args.workflow_name,
      },
      throwOnError: false,
    })
    if (result.data) {
      context.metadata({
        title: `Workflow ${result.data.workflow_name} loaded`,
        metadata: {
          agent_name: result.data.agent_name,
          workflow_name: result.data.workflow_name,
          node_count: result.data.nodes.length,
          edge_count: result.data.edges.length,
        },
      })
      return workflowToMarkdown(result.data)
    }

    const error = zError.safeParse(result.error)
    if (!error.success) {
      context.metadata({
        title: "Workflow retrieval failed",
        metadata: { agent_name: agentName, reason: "unexpected_error" },
      })
      return `Workflow retrieval failed for agent ${agentName}, and the service returned an unexpected error shape.`
    }

    context.metadata({
      title: "Workflow retrieval failed",
      metadata: {
        agent_name: agentName,
        workflow_name: args.workflow_name,
        code: error.data.code,
        errors: error.data.errors ?? [],
      },
    })

    if (error.data.code === "not_found") {
      return `Workflow ${args.workflow_name} was not found for agent ${agentName}. Create it first or verify the workflow_name before retrying.`
    }

    return workflowErrorOutput(error.data)
  },
})

function workflowToMarkdown(workflow: Workflow) {
  const nodeIndex = new Map<string, number>()
  const nodeByName = new Map<string, WorkflowNode>()
  for (const [index, node] of workflow.nodes.entries()) {
    nodeIndex.set(node.name, index)
    nodeByName.set(node.name, node)
  }
  const incomingByNode = new Map<string, WorkflowEdge[]>()
  const outgoingByNode = new Map<string, WorkflowEdge[]>()
  const indegreeByNode = new Map<string, number>()

  for (const node of workflow.nodes) {
    incomingByNode.set(node.name, [])
    outgoingByNode.set(node.name, [])
  }

  let conditionalEdgeCount = 0
  for (const edge of workflow.edges) {
    outgoingByNode.get(edge.source)?.push(edge)
    incomingByNode.get(edge.target)?.push(edge)
    indegreeByNode.set(edge.target, (indegreeByNode.get(edge.target) ?? 0) + 1)
    if (edge.condition_summary) {
      conditionalEdgeCount++
    }
  }

  const ready = workflow.nodes
    .filter((node) => (indegreeByNode.get(node.name) ?? 0) === 0)
    .sort((left, right) => (nodeIndex.get(left.name) ?? 0) - (nodeIndex.get(right.name) ?? 0))
  const orderedNodes: WorkflowNode[] = []
  const remainingIndegree = new Map(indegreeByNode)

  while (ready.length > 0) {
    const node = ready.shift()
    if (!node) {
      break
    }
    orderedNodes.push(node)

    const outgoingEdges = outgoingByNode.get(node.name) ?? []
    for (const edge of outgoingEdges) {
      const nextIndegree = (remainingIndegree.get(edge.target) ?? 0) - 1
      remainingIndegree.set(edge.target, nextIndegree)
      if (nextIndegree !== 0) {
        continue
      }

      const targetNode = nodeByName.get(edge.target)
      if (!targetNode) {
        continue
      }

      ready.push(targetNode)
      ready.sort(
        (left, right) => (nodeIndex.get(left.name) ?? 0) - (nodeIndex.get(right.name) ?? 0)
      )
    }
  }

  const executionNodes =
    orderedNodes.length === workflow.nodes.length ? orderedNodes : workflow.nodes
  const startNodes = executionNodes
    .filter((node) => (incomingByNode.get(node.name)?.length ?? 0) === 0)
    .map((node) => node.name)
  const terminalNodes = executionNodes
    .filter((node) => (outgoingByNode.get(node.name)?.length ?? 0) === 0)
    .map((node) => node.name)

  const lines = [
    `# ${workflow.title} (\`${workflow.workflow_name}\`)`,
    "",
    "## Metadata",
    `- Agent: \`${workflow.agent_name}\``,
    `- Workflow name: \`${workflow.workflow_name}\``,
    `- Summary: ${workflow.summary}`,
    `- Inputs: ${workflow.inputs ? Object.keys(workflow.inputs).length : 0}`,
    `- Created at: ${workflow.created_at}`,
    `- Updated at: ${workflow.updated_at}`,
    `- Node count: ${workflow.nodes.length}`,
    `- Edge count: ${workflow.edges.length}`,
    "",
    "## Graph Overview",
    `- Start nodes: ${joinNames(startNodes)}`,
    `- Terminal nodes: ${joinNames(terminalNodes)}`,
    `- Conditional edges: ${conditionalEdgeCount}`,
    `- Unconditional edges: ${workflow.edges.length - conditionalEdgeCount}`,
    "",
    "## Inputs",
    workflow.inputs ? formatInputs(workflow.inputs) : "- No declared inputs.",
    "",
    "## Execution Order",
  ]

  for (const [index, node] of executionNodes.entries()) {
    lines.push(`${index + 1}. \`${node.name}\``)
  }

  for (const [index, node] of executionNodes.entries()) {
    lines.push("")
    lines.push(`## Node ${index + 1}: \`${node.name}\``)
    lines.push(`- Execution position: ${index + 1}`)
    lines.push(`- Goal: ${node.goal}`)
    lines.push(`- Done criteria: ${node.done_criteria}`)
    lines.push(`- Preferred tools: ${joinNames(node.preferred_tools ?? [])}`)
    lines.push(`- Incoming transitions: ${joinTransitions(incomingByNode.get(node.name) ?? [])}`)
    lines.push(`- Outgoing transitions: ${joinTransitions(outgoingByNode.get(node.name) ?? [])}`)
    lines.push("")
    lines.push("### Instructions")
    lines.push(node.instructions)
    lines.push("")
    lines.push("### Transition Details")

    const outgoingEdges = outgoingByNode.get(node.name) ?? []
    if (outgoingEdges.length === 0) {
      lines.push("- No outgoing transitions. This is a terminal node.")
      continue
    }

    for (const edge of outgoingEdges) {
      lines.push(`- Path: \`${edge.source}\` -> \`${edge.target}\``)
      lines.push(`  Branch: ${edge.branch_label || "unconditional"}`)
      lines.push(`  Condition summary: ${edge.condition_summary || "none"}`)
    }
  }

  return lines.join("\n")
}

function joinNames(values: Array<string>) {
  if (values.length === 0) {
    return "none"
  }
  return values.map((value) => `\`${value}\``).join(", ")
}

function joinTransitions(edges: Array<WorkflowEdge>) {
  if (edges.length === 0) {
    return "none"
  }

  return edges
    .map((edge) => {
      const branch = edge.branch_label ? ` [${edge.branch_label}]` : ""
      return `\`${edge.source}\` -> \`${edge.target}\`${branch}`
    })
    .join(", ")
}

function formatInputs(inputs: NonNullable<Workflow["inputs"]>) {
  const lines: Array<string> = []

  for (const [name, schemaValue] of Object.entries(inputs).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const attrs = [
      `type=${schemaValue.type}`,
      `required=${schemaValue.required ? "true" : "false"}`,
    ]

    if (schemaValue.description) {
      attrs.push(`description=${JSON.stringify(schemaValue.description)}`)
    }
    if (schemaValue.default !== undefined) {
      attrs.push(`default=${JSON.stringify(schemaValue.default)}`)
    }
    if (schemaValue.enum && schemaValue.enum.length > 0) {
      attrs.push(`enum=${JSON.stringify(schemaValue.enum)}`)
    }
    if (schemaValue.minLength !== undefined) {
      attrs.push(`minLength=${schemaValue.minLength}`)
    }
    if (schemaValue.maxLength !== undefined) {
      attrs.push(`maxLength=${schemaValue.maxLength}`)
    }
    if (schemaValue.pattern) {
      attrs.push(`pattern=${JSON.stringify(schemaValue.pattern)}`)
    }
    if (schemaValue.format) {
      attrs.push(`format=${schemaValue.format}`)
    }
    if (schemaValue.minimum !== undefined) {
      attrs.push(`minimum=${schemaValue.minimum}`)
    }
    if (schemaValue.maximum !== undefined) {
      attrs.push(`maximum=${schemaValue.maximum}`)
    }
    if (schemaValue.exclusiveMinimum !== undefined) {
      attrs.push(`exclusiveMinimum=${schemaValue.exclusiveMinimum}`)
    }
    if (schemaValue.exclusiveMaximum !== undefined) {
      attrs.push(`exclusiveMaximum=${schemaValue.exclusiveMaximum}`)
    }
    if (schemaValue.multipleOf !== undefined) {
      attrs.push(`multipleOf=${schemaValue.multipleOf}`)
    }

    lines.push(`- \`${name}\`: ${attrs.join(", ")}`)
  }

  return lines.length > 0 ? lines.join("\n") : "- No declared inputs."
}
