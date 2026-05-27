import { tool } from "@opencode-ai/plugin"

import { createWorkflow, type CreateWorkflowRequest } from "../lib/gateway"
import { zError } from "../lib/gateway"
import { agentNameFromResourceAttributes, workflowErrorOutput } from "../lib/workflow"

const workflowInputSchema = tool.schema
  .object({
    type: tool.schema.enum(["string", "integer", "number", "boolean"]),
    description: tool.schema.string().min(1).max(1024).optional(),
    required: tool.schema.boolean(),
    default: tool.schema
      .union([tool.schema.string(), tool.schema.number(), tool.schema.boolean()])
      .optional(),
    enum: tool.schema
      .array(tool.schema.union([tool.schema.string(), tool.schema.number(), tool.schema.boolean()]))
      .min(1)
      .optional(),
    minLength: tool.schema.number().int().min(0).max(2048).optional(),
    maxLength: tool.schema.number().int().min(0).max(2048).optional(),
    pattern: tool.schema.string().min(1).max(1024).optional(),
    format: tool.schema.enum(["email", "uri", "uuid", "date", "date-time"]).optional(),
    minimum: tool.schema.number().optional(),
    maximum: tool.schema.number().optional(),
    exclusiveMinimum: tool.schema.number().optional(),
    exclusiveMaximum: tool.schema.number().optional(),
    multipleOf: tool.schema.number().gt(0).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.minLength !== undefined &&
      value.maxLength !== undefined &&
      value.minLength > value.maxLength
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["minLength"],
        message: "minLength must be less than or equal to maxLength",
      })
    }

    if (
      value.minimum !== undefined &&
      value.maximum !== undefined &&
      value.minimum > value.maximum
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["minimum"],
        message: "minimum must be less than or equal to maximum",
      })
    }

    if (
      value.exclusiveMinimum !== undefined &&
      value.exclusiveMaximum !== undefined &&
      value.exclusiveMinimum >= value.exclusiveMaximum
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["exclusiveMinimum"],
        message: "exclusiveMinimum must be less than exclusiveMaximum",
      })
    }
  })

const createWorkflowArgs = {
  inputs: tool.schema
    .record(tool.schema.string().min(1), workflowInputSchema)
    .optional()
    .describe(
      "Optional flat object keyed by input name. " +
        "Each value must be a typed schema object with explicit fields like type, required, default, and enum. " +
        "String and numeric bounds must be ordered correctly. " +
        'Plain strings like {target_url: "string"} and extra JSON Schema metadata are NOT valid.'
    ),
  workflow_name: tool.schema
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
    .describe(
      "Stable DNS-label workflow identifier scoped to this agent, for example triage-review."
    ),
  title: tool.schema
    .string()
    .min(1)
    .max(256)
    .describe("Short human title that explains the workflow's purpose."),
  summary: tool.schema
    .string()
    .min(1)
    .max(4096)
    .describe("High-level summary of the overall workflow, its trigger, and intended end state."),
  nodes: tool.schema
    .array(
      tool.schema.object({
        name: tool.schema
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
        instructions: tool.schema.string().min(1).max(16384),
        goal: tool.schema.string().min(1).max(2048),
        done_criteria: tool.schema.string().min(1).max(2048),
        preferred_tools: tool.schema.array(tool.schema.string().min(1).max(128)),
      })
    )
    .min(1)
    .describe(
      "All workflow nodes. Each node must define concrete instructions, goal, done_criteria, and preferred_tools."
    ),
  edges: tool.schema
    .array(
      tool.schema.object({
        source: tool.schema
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
        target: tool.schema
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
        branch_label: tool.schema.string().max(256),
        condition_summary: tool.schema.string().max(1024),
      })
    )
    .describe(
      "Directed edges between nodes. Use branch_label for branch names. " +
        "When a node has multiple outgoing edges, every outgoing edge must define a non-empty condition_summary."
    ),
}

const description = `
Create a reusable workflow DAG.

Use this tool when the user wants to save a reusable workflow definition, not when they only want a prose plan in chat.

The workflow is a directed acyclic graph:
- Each node is one execution step with concrete agent instructions.
- Edges define allowed transitions between nodes.
- Branching is explicit on edges, not buried inside node text.

Call this tool only after you have finalized the full workflow graph.

Authoring rules:
- workflow_name must be a DNS label up to 32 characters, for example triage-review or incident-intake.
- inputs is optional. If present, it must be a flat object keyed by input name.
- Each inputs entry must be a schema object with at least type and required.
- Each inputs entry may use only these keys: type, description, required, default, enum, minLength, maxLength, pattern, format, minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf.
- Supported input types are scalar only: string, integer, number, and boolean.
- If both minLength and maxLength are set, minLength must be less than or equal to maxLength.
- If both minimum and maximum are set, minimum must be less than or equal to maximum.
- If both exclusiveMinimum and exclusiveMaximum are set, exclusiveMinimum must be less than exclusiveMaximum.
- multipleOf must be greater than 0.
- required belongs inside each inputs.<name> schema object. Do not use top-level JSON Schema required arrays inside one input definition.
- Nested object or array input schemas are NOT supported.
- Extra JSON Schema metadata such as $schema, title, properties, items, additionalProperties, oneOf, anyOf, or allOf is NOT supported and may fail metaschema validation.
- Workflow definition inputs declare the schema. Runtime workflow or schedule inputs are separate JSON values validated against that schema.
- Every node.name must also be a DNS label and unique within the workflow.
- The graph must be connected and acyclic.
- The graph must have at least one start node and at least one terminal node.
- preferred_tools should list the concrete OpenCode tools or MCP tools the node should prefer.
- branch_label names the branch shown to humans, for example approved, needs-info, or blocked.
- condition_summary is the plain-language branch condition shown to humans and the executor.
- For straight-line transitions, leave branch_label and condition_summary as empty strings.

Branching semantics:
- Use multiple outgoing edges when the next step depends on a decision or observed outcome.
- Keep branch conditions on edges, not inside node instructions.
- If a node has multiple outgoing edges, each outgoing edge must have a non-empty condition_summary.
- Do not use an unlabeled default edge from a branching node.

If the service reports workflow_name already in use, inform the user that you are renaming the workflow, choose a new DNS-label workflow_name yourself, and retry.

Example:
{
  "workflow_name": "repo-triage",
  "title": "Repository Triage and Fix Routing",
  "summary": "Inspect a reported issue, decide whether it is reproducible, then route to fix or clarification.",
  "inputs": {
    "issue_url": {
      "type": "string",
      "required": true,
      "format": "uri",
      "description": "Issue or report URL to inspect first."
    },
    "max_files": {
      "type": "integer",
      "required": false,
      "default": 50,
      "minimum": 1,
      "maximum": 500
    }
  },
  "nodes": [
    {
      "name": "intake",
      "instructions": "Read the report and inspect repository context before choosing the next step.",
      "goal": "Classify the reported issue.",
      "done_criteria": "The issue is understood well enough for investigation.",
      "preferred_tools": ["read", "grep", "glob"]
    },
    {
      "name": "reproduce",
      "instructions": "Reproduce or disprove the reported behavior with the available information.",
      "goal": "Confirm current behavior.",
      "done_criteria": "The bug is reproduced or ruled out.",
      "preferred_tools": ["bash", "read"]
    },
    {
      "name": "fix",
      "instructions": "Implement and verify a safe fix once the bug is reproduced.",
      "goal": "Land a safe code change.",
      "done_criteria": "Checks are complete and the fix is verified.",
      "preferred_tools": ["edit", "bash"]
    },
    {
      "name": "clarify",
      "instructions": "Gather the missing information needed to continue investigation.",
      "goal": "Unblock reproduction.",
      "done_criteria": "The missing inputs are enumerated for the user.",
      "preferred_tools": ["question"]
    }
  ],
  "edges": [
    {
      "source": "intake",
      "target": "reproduce",
      "branch_label": "",
      "condition_summary": ""
    },
    {
      "source": "reproduce",
      "target": "fix",
      "branch_label": "reproduced",
      "condition_summary": "The reported behavior is reproduced locally."
    },
    {
      "source": "reproduce",
      "target": "clarify",
      "branch_label": "needs-info",
      "condition_summary": "The issue cannot be reproduced with current information."
    }
  ]
}

If a workflow does not need parameters, omit inputs entirely.

Do:
- "inputs": { "target_url": { "type": "string", "required": true, "format": "uri" } }
- "inputs": { "first_input": { "type": "string", "required": true }, "second_input": { "type": "string", "required": false, "description": "Optional secondary value." } }

Do NOT:
- "inputs": { "target_url": "string" }
- "inputs": { "repo": { "type": "object", "required": true, "properties": { "url": { "type": "string" } } } }
- "inputs": { "first_input": { "$schema": "https://json-schema.org/draft/2020-12/schema", "type": "string", "title": "Example Input", "required": true }, "second_input": { "type": "string", "required": false, "oneOf": [{ "type": "string" }, { "type": "null" }] } }

Successful calls save the workflow for the current agent.
`.trim()

type CreateWorkflowToolInput = Omit<CreateWorkflowRequest, "agent_name">

export default tool({
  description,
  args: createWorkflowArgs,
  async execute(args: CreateWorkflowToolInput, context) {
    const agentName = agentNameFromResourceAttributes(process.env.OPENCODE_RESOURCE_ATTRIBUTES)
    if (!agentName) {
      context.metadata({
        title: "Workflow creation unavailable",
        metadata: { reason: "missing_agent_name" },
      })
      return "Could not derive clawarmor.agent_name from OPENCODE_RESOURCE_ATTRIBUTES. Configure the agent runtime to inject that resource attribute before using create_workflow."
    }

    context.metadata({
      title: `Create workflow ${args.workflow_name}`,
      metadata: {
        agent_name: agentName,
        workflow_name: args.workflow_name,
      },
    })

    const body = {
      agent_name: agentName,
      ...args,
    } satisfies CreateWorkflowRequest

    const result = await createWorkflow({
      body,
      throwOnError: false,
    })
    if (result.data) {
      context.metadata({
        title: `Workflow ${result.data.workflow_name} created`,
        metadata: {
          agent_name: result.data.agent_name,
          workflow_name: result.data.workflow_name,
          node_count: result.data.nodes.length,
          edge_count: result.data.edges.length,
        },
      })
      return `Created workflow ${result.data.workflow_name} for agent ${result.data.agent_name} with ${result.data.nodes.length} nodes and ${result.data.edges.length} edges.`
    }

    const error = zError.safeParse(result.error)
    if (!error.success) {
      context.metadata({
        title: "Workflow creation failed",
        metadata: { agent_name: agentName, reason: "unexpected_error" },
      })
      return `Workflow creation failed for agent ${agentName}, and the service returned an unexpected error shape.`
    }

    context.metadata({
      title: "Workflow creation failed",
      metadata: {
        agent_name: agentName,
        code: error.data.code,
        errors: error.data.errors ?? [],
      },
    })
    return workflowErrorOutput(error.data)
  },
})
