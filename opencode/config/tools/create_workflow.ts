import { tool } from "@opencode-ai/plugin";

import {
  createWorkflow,
  type CreateWorkflowRequest,
  type GatewayError,
} from "../lib/gateway";
import { zError } from "../lib/gateway";

const createWorkflowArgs = {
  workflow_name: tool.schema
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
    .describe(
      "Stable DNS-label workflow identifier scoped to this agent, for example triage-review.",
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
    .describe(
      "High-level summary of the overall workflow, its trigger, and intended end state.",
    ),
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
        expected_output: tool.schema.string().min(1).max(2048),
        done_criteria: tool.schema.string().min(1).max(2048),
        preferred_tools: tool.schema.array(
          tool.schema.string().min(1).max(128),
        ),
      }),
    )
    .min(1)
    .describe(
      "All workflow nodes. Each node must define concrete instructions, goal, expected_output, done_criteria, and preferred_tools.",
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
        cel_expression: tool.schema.string().max(2048),
      }),
    )
    .describe(
      "Directed edges between nodes. Use branch_label for branch names. For conditional branches, condition_summary and cel_expression must both be set.",
    ),
};

const description = `
Create a persisted ClawArmor workflow DAG for the current agent.

Use this tool when the user wants the agent to save a reusable workflow definition, not when they only want a prose plan in chat.

The workflow is a single-agent directed acyclic graph:
- Each node is one execution step with concrete agent instructions.
- Edges define allowed transitions between nodes.
- Branching is explicit on edges, not buried inside node text.

Call this tool only after you have finalized the full workflow graph.

Authoring rules:
- workflow_name must be a DNS label up to 32 characters, for example triage-review or incident-intake.
- Every node.name must also be a DNS label and unique within the workflow.
- The graph must be connected and acyclic.
- The graph must have at least one start node and at least one terminal node.
- preferred_tools should list the concrete OpenCode tools or MCP tools the node should prefer.
- branch_label names the branch shown to humans, for example approved, needs-info, or blocked.
- condition_summary is a plain-language explanation of the branch condition.
- cel_expression is the machine-readable CEL condition. condition_summary and cel_expression must be provided together.
- For unconditional edges, leave branch_label, condition_summary, and cel_expression as empty strings.

Branching semantics:
- Use multiple outgoing edges when the next step depends on a decision or observed outcome.
- Keep branch conditions on edges, not inside node instructions.
- CEL expressions must evaluate to a boolean and may reference input, workflow, steps, and vars.
- Prefer conditions that describe observable outcomes, for example steps.research.status == "complete" or vars.risk_score >= 7.

If the service reports workflow_name already in use, inform the user that you are renaming the workflow, choose a new DNS-label workflow_name yourself, and retry.

Example:
Create a workflow for repository triage.
- workflow_name: repo-triage
- title: Repository Triage and Fix Routing
- summary: Inspect a reported issue, decide whether it is reproducible, then route to fix or clarification.
- nodes:
  - intake: instructions explain how to read the report and repo context; goal is to classify the issue; expected_output is a normalized problem statement; done_criteria says the issue is understood well enough for investigation; preferred_tools might include read, grep, glob.
  - reproduce: instructions explain how to reproduce or disprove the issue; goal is to confirm current behavior; expected_output is reproduction evidence; done_criteria says the bug is reproduced or ruled out; preferred_tools might include bash, read.
  - fix: instructions explain how to implement and verify a fix; goal is to land a safe code change; expected_output is a validated patch summary; done_criteria says tests or checks are complete; preferred_tools might include edit, bash.
  - clarify: instructions explain how to gather missing information from the user; goal is to unblock reproduction; expected_output is a precise clarification request; done_criteria says the missing inputs are enumerated; preferred_tools might include question.
- edges:
  - intake -> reproduce with branch_label "" and empty condition fields.
  - reproduce -> fix with branch_label "reproduced", condition_summary "The reported behavior is reproduced locally", cel_expression 'steps.reproduce.status == "reproduced"'.
  - reproduce -> clarify with branch_label "needs-info", condition_summary "The issue cannot be reproduced with current information", cel_expression 'steps.reproduce.status == "needs_info"'.

Successful calls save the workflow for the current agent.
`.trim();

type CreateWorkflowToolInput = Omit<CreateWorkflowRequest, "agent_name">;

export default tool({
  description,
  args: createWorkflowArgs,
  async execute(args: CreateWorkflowToolInput, context) {
    const agentName = agentNameFromResourceAttributes(
      process.env.OPENCODE_RESOURCE_ATTRIBUTES,
    );
    if (!agentName) {
      context.metadata({
        title: "Workflow creation unavailable",
        metadata: { reason: "missing_agent_name" },
      });
      return "Could not derive clawarmor.agent_name from OPENCODE_RESOURCE_ATTRIBUTES. Configure the agent runtime to inject that resource attribute before using create_workflow.";
    }

    context.metadata({
      title: `Create workflow ${args.workflow_name}`,
      metadata: {
        agent_name: agentName,
        workflow_name: args.workflow_name,
      },
    });

    const body = {
      agent_name: agentName,
      ...args,
    } satisfies CreateWorkflowRequest;

    const result = await createWorkflow({
      body,
      throwOnError: false,
    });
    if (result.data) {
      context.metadata({
        title: `Workflow ${result.data.workflow_name} created`,
        metadata: {
          agent_name: result.data.agent_name,
          workflow_name: result.data.workflow_name,
          node_count: result.data.nodes.length,
          edge_count: result.data.edges.length,
        },
      });
      return `Created workflow ${result.data.workflow_name} for agent ${result.data.agent_name} with ${result.data.nodes.length} nodes and ${result.data.edges.length} edges.`;
    }

    const error = zError.safeParse(result.error);
    if (!error.success) {
      context.metadata({
        title: "Workflow creation failed",
        metadata: { agent_name: agentName, reason: "unexpected_error" },
      });
      return `Workflow creation failed for agent ${agentName}, and the service returned an unexpected error shape.`;
    }

    context.metadata({
      title: "Workflow creation failed",
      metadata: {
        agent_name: agentName,
        code: error.data.code,
        errors: error.data.errors ?? [],
      },
    });
    return workflowErrorOutput(error.data);
  },
});

function agentNameFromResourceAttributes(input: string | undefined) {
  if (!input) {
    return "";
  }

  for (const item of input.split(",")) {
    const [key, value] = item.split("=", 2);
    if (key?.trim() !== "clawarmor.agent_name") {
      continue;
    }
    return value?.trim() ?? "";
  }

  return "";
}

function workflowErrorOutput(error: GatewayError) {
  const lines = [`${error.code}: ${error.message}`];
  for (const field of error.errors ?? []) {
    lines.push(`${field.field}: ${field.message}`);
  }
  return lines.join("\n");
}
