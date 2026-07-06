import { tool } from "@opencode-ai/plugin"

import { createWorkflow, type CreateWorkflowRequest, zError } from "../lib/gateway"
import { zCreateWorkflowBody } from "../lib/gateway/client/zod.gen"
import {
  formatRequestValidationError,
  validateWorkflowDefinition,
  workflowAgentName,
  workflowErrorOutput,
} from "../lib/workflow"

const workflowInputSchema = tool.schema.object({
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

const createWorkflowArgs = {
  inputs: tool.schema
    .record(tool.schema.string().min(1), workflowInputSchema)
    .optional()
    .describe(
      "Optional flat object keyed by input name. " +
        "Each value must be a typed schema object with explicit fields like type, required, default, and enum. " +
        'Plain strings like {target_url: "string"} and extra JSON Schema metadata are NOT valid.'
    ),
  arbitrary_json: tool.schema
    .object({
      description: tool.schema.string().min(1).max(1024).optional(),
      default_payload: tool.schema.json().optional(),
    })
    .optional()
    .describe(
      "Optional arbitrary JSON input contract. Use this instead of inputs when the workflow accepts one free-form JSON payload."
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
        preferred_skills: tool.schema
          .array(
            tool.schema
              .string()
              .min(1)
              .max(64)
              .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
          )
          .optional(),
        preferred_tools: tool.schema.array(tool.schema.string().min(1).max(128)).optional(),
      })
    )
    .min(1)
    .describe(
      "All workflow nodes. Each node must define concrete instructions, goal, done_criteria and can optionally declare preferred_skills and preferred_tools."
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
        "When a node has multiple outgoing edges, every outgoing edge must define a non-empty branch_label and condition_summary."
    ),
}

const description = `
Create a reusable workflow DAG.

Load and follow the built-in "workflow-creator" skill before using this tool (VERY IMPORTANT).

Use this tool when you/user wants to create a reusable workflow definition, not when you/user only want a prose plan.

Call this tool only after you have manually executed the intended task end-to-end at least once and finalized the full workflow graph.

For recurring automation or scheduled execution, create or update a skill or script first unless the repeated logic is truly trivial.

If you have not yet exercised the task successfully, keep working instead of calling this tool.

If the service reports "workflow_name" already in use, surface the conflict. Do not rename the workflow automatically.
`.trim()

type CreateWorkflowToolInput = CreateWorkflowRequest

export default tool({
  description,
  args: createWorkflowArgs,
  async execute(args: CreateWorkflowToolInput, context) {
    const agentName = workflowAgentName()
    if (!agentName) {
      context.metadata({
        title: "Workflow creation unavailable",
        metadata: { reason: "missing_agent_name" },
      })
      return "AGENTZ_AGENT_NAME is not set. Configure the agent runtime before using create_workflow."
    }

    context.metadata({
      title: `Create workflow ${args.workflow_name}`,
      metadata: {
        agent_name: agentName,
        workflow_name: args.workflow_name,
      },
    })

    const bodyInput = args satisfies CreateWorkflowRequest

    const bodyResult = zCreateWorkflowBody.safeParse(bodyInput)
    if (!bodyResult.success) {
      const issues = bodyResult.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.join(".") : "request",
        message: issue.message,
      }))
      context.metadata({
        title: "Workflow creation failed",
        metadata: {
          agent_name: agentName,
          workflow_name: args.workflow_name,
          reason: "invalid_request_body",
          issues,
        },
      })
      return formatRequestValidationError("Workflow creation request validation failed.", issues)
    }

    const body = bodyResult.data
    const validationIssues = validateWorkflowDefinition(body)
    if (validationIssues.length > 0) {
      context.metadata({
        title: "Workflow creation failed",
        metadata: {
          agent_name: agentName,
          workflow_name: body.workflow_name,
          reason: "invalid_workflow_definition",
          issues: validationIssues,
        },
      })
      return formatRequestValidationError(
        "Workflow definition validation failed.",
        validationIssues
      )
    }

    const result = await createWorkflow({
      path: { agentName },
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
      return (
        `Created workflow ${result.data.workflow_name} for agent ` +
        `${result.data.agent_name} with ${result.data.nodes.length} nodes ` +
        `and ${result.data.edges.length} edges.`
      )
    }

    const error = zError.safeParse(result.error)
    if (!error.success) {
      context.metadata({
        title: "Workflow creation failed",
        metadata: { agent_name: agentName, reason: "unexpected_error" },
      })
      return (
        `Workflow creation failed for agent ${agentName}, and the service ` +
        "returned an unexpected error shape."
      )
    }

    context.metadata({
      title: "Workflow creation failed",
      metadata: {
        agent_name: agentName,
        workflow_name: args.workflow_name,
        code: error.data.code,
        errors: error.data.errors ?? [],
      },
    })

    if (error.data.code === "already_exists") {
      return (
        `Workflow ${args.workflow_name} already exists for agent ${agentName}. ` +
        "Choose a new workflow_name or delete the existing workflow before " +
        "recreating it."
      )
    }

    return workflowErrorOutput(error.data)
  },
})
