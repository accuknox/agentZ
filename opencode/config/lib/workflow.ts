import type { CreateWorkflowRequest, GatewayError } from "./gateway"
import type { WorkflowInputSchema } from "./gateway/client"

export type RequestValidationIssue = {
  path: string
  message: string
}

const skillNamePattern = /^[a-z0-9]+(-[a-z0-9]+)*$/

export function workflowAgentName() {
  return process.env.CLAWARMOR_AGENT_NAME?.trim() ?? ""
}

export function workflowErrorOutput(error: GatewayError) {
  const lines = [`${error.code}: ${error.message}`]
  if ((error.errors ?? []).some((field) => field.field.startsWith("inputs."))) {
    lines.push(
      "Hint: inputs must be a flat object keyed by input name. Each value must be a typed schema object with required `type` and `required` fields. Only scalar input types and the documented schema keys are supported. Bounds must be ordered correctly and `multipleOf` must be greater than 0."
    )
  }
  for (const field of error.errors ?? []) {
    lines.push(`${field.field}: ${field.message}`)
  }
  return lines.join("\n")
}

export function formatRequestValidationError(
  heading: string,
  issues: Array<RequestValidationIssue>
) {
  const lines = [heading]
  for (const issue of issues) {
    lines.push(`${issue.path}: ${issue.message}`)
  }
  return lines.join("\n")
}

export function validateWorkflowDefinition(body: CreateWorkflowRequest) {
  const issues: RequestValidationIssue[] = []
  const nodeNames = new Set<string>()
  const incoming = new Map<string, number>()
  const outgoing = new Map<string, number>()
  const outgoingEdges = new Map<
    string,
    Array<{ edge: CreateWorkflowRequest["edges"][number]; index: number }>
  >()
  const undirected = new Map<string, Set<string>>()

  for (const [name, input] of Object.entries(body.inputs ?? {})) {
    validateWorkflowInput(issues, name, input)
  }

  for (const [index, node] of body.nodes.entries()) {
    if (nodeNames.has(node.name)) {
      issues.push({
        path: `nodes.${index}.name`,
        message: `duplicate node name ${node.name}`,
      })
      continue
    }

    nodeNames.add(node.name)
    incoming.set(node.name, 0)
    outgoing.set(node.name, 0)
    undirected.set(node.name, new Set())

    const preferredSkills = node.preferred_skills ?? []
    const seenSkills = new Set<string>()
    for (const [skillIndex, skillName] of preferredSkills.entries()) {
      if (!skillNamePattern.test(skillName)) {
        issues.push({
          path: `nodes.${index}.preferred_skills.${skillIndex}`,
          message: `invalid skill name ${skillName}`,
        })
        continue
      }

      if (seenSkills.has(skillName)) {
        issues.push({
          path: `nodes.${index}.preferred_skills.${skillIndex}`,
          message: `duplicate skill name ${skillName}`,
        })
        continue
      }

      seenSkills.add(skillName)
    }
  }

  for (const [index, edge] of body.edges.entries()) {
    if (!nodeNames.has(edge.source)) {
      issues.push({
        path: `edges.${index}.source`,
        message: `unknown source node ${edge.source}`,
      })
      continue
    }
    if (!nodeNames.has(edge.target)) {
      issues.push({
        path: `edges.${index}.target`,
        message: `unknown target node ${edge.target}`,
      })
      continue
    }

    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1)
    outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1)
    outgoingEdges.set(edge.source, [...(outgoingEdges.get(edge.source) ?? []), { edge, index }])
    undirected.get(edge.source)?.add(edge.target)
    undirected.get(edge.target)?.add(edge.source)
  }

  for (const edges of outgoingEdges.values()) {
    if (edges.length < 2) {
      continue
    }

    for (const { edge, index } of edges) {
      if (edge.branch_label.trim() === "") {
        issues.push({
          path: `edges.${index}.branch_label`,
          message: "branch_label is required when a node has multiple outgoing edges",
        })
      }
      if (edge.condition_summary.trim() === "") {
        issues.push({
          path: `edges.${index}.condition_summary`,
          message: "condition_summary is required when a node has multiple outgoing edges",
        })
      }
    }
  }

  const startNodes = body.nodes.filter((node) => (incoming.get(node.name) ?? 0) === 0)
  if (startNodes.length === 0) {
    issues.push({
      path: "edges",
      message: "workflow must have at least one start node",
    })
  }

  const terminalNodes = body.nodes.filter((node) => (outgoing.get(node.name) ?? 0) === 0)
  if (terminalNodes.length === 0) {
    issues.push({
      path: "edges",
      message: "workflow must have at least one terminal node",
    })
  }

  if (
    body.nodes.length > 0 &&
    !isConnected(
      body.nodes.map((node) => node.name),
      undirected
    )
  ) {
    issues.push({
      path: "edges",
      message: "workflow graph must be connected",
    })
  }

  if (
    hasCycle(
      body.nodes.map((node) => node.name),
      outgoingEdges
    )
  ) {
    issues.push({
      path: "edges",
      message: "workflow graph must be acyclic",
    })
  }

  return issues
}

function validateWorkflowInput(
  issues: RequestValidationIssue[],
  name: string,
  input: WorkflowInputSchema
) {
  if (input.minLength !== undefined && input.maxLength !== undefined) {
    if (input.minLength > input.maxLength) {
      issues.push({
        path: `inputs.${name}.minLength`,
        message: "minLength must be less than or equal to maxLength",
      })
    }
  }

  if (input.minimum !== undefined && input.maximum !== undefined) {
    if (input.minimum > input.maximum) {
      issues.push({
        path: `inputs.${name}.minimum`,
        message: "minimum must be less than or equal to maximum",
      })
    }
  }

  if (
    input.exclusiveMinimum !== undefined &&
    input.exclusiveMaximum !== undefined &&
    input.exclusiveMinimum >= input.exclusiveMaximum
  ) {
    issues.push({
      path: `inputs.${name}.exclusiveMinimum`,
      message: "exclusiveMinimum must be less than exclusiveMaximum",
    })
  }
}

function isConnected(nodeNames: string[], graph: Map<string, Set<string>>) {
  const [start] = nodeNames
  if (!start) {
    return true
  }

  const seen = new Set<string>([start])
  const stack = [start]
  while (stack.length > 0) {
    const node = stack.pop()
    if (!node) {
      continue
    }

    for (const next of graph.get(node) ?? []) {
      if (seen.has(next)) {
        continue
      }
      seen.add(next)
      stack.push(next)
    }
  }

  return seen.size === nodeNames.length
}

function hasCycle(
  nodeNames: string[],
  outgoingEdges: Map<string, Array<{ edge: CreateWorkflowRequest["edges"][number]; index: number }>>
) {
  const visiting = new Set<string>()
  const visited = new Set<string>()

  for (const node of nodeNames) {
    if (visited.has(node)) {
      continue
    }
    if (visit(node, outgoingEdges, visiting, visited)) {
      return true
    }
  }

  return false
}

function visit(
  node: string,
  outgoingEdges: Map<
    string,
    Array<{ edge: CreateWorkflowRequest["edges"][number]; index: number }>
  >,
  visiting: Set<string>,
  visited: Set<string>
) {
  if (visiting.has(node)) {
    return true
  }
  if (visited.has(node)) {
    return false
  }

  visiting.add(node)
  for (const { edge } of outgoingEdges.get(node) ?? []) {
    if (visit(edge.target, outgoingEdges, visiting, visited)) {
      return true
    }
  }
  visiting.delete(node)
  visited.add(node)
  return false
}
