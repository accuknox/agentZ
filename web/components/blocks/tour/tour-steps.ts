export type TourStep = {
  /** CSS selector for the element to highlight. */
  selector: string
  title: string
  description: string
  side?: "top" | "right" | "bottom" | "left"
  align?: "start" | "center" | "end"
}

const sidebar = "[data-app-sidebar]"

/**
 * Ordered tour of the product. Steps whose selector matches nothing visible in
 * the current DOM are dropped before the tour starts, so one list covers the
 * account, organization and workspace scopes.
 */
export const tourSteps: TourStep[] = [
  {
    selector: `${sidebar} [data-sidebar="header"]`,
    title: "Organization and workspace",
    description:
      "Switch organization or workspace here. Each workspace keeps its own agents, sandboxes, connections and inference settings.",
  },
  {
    selector: '[data-tour="new-chat"]',
    title: "Start a chat",
    description:
      "Talk to an agent. It answers from the sandbox, the skills and the model you gave it.",
  },
  {
    selector: '[data-tour="sessions"]',
    title: "Your chats",
    description:
      "Every chat and workflow run lands here. Search them, group them, or filter them by agent.",
  },
  {
    selector: `${sidebar} a[href$="/agents"]`,
    title: "Agents",
    description:
      "An agent does the work for you. Ask one to triage alerts, review a repo, or pull a weekly report. It keeps its files between runs, so it picks up where it left off.",
  },
  {
    selector: `${sidebar} a[href$="/skills"]`,
    title: "Skills",
    description:
      "Skills teach an agent a task. Upload your own with versions and rollbacks, or let agents write their own.",
  },
  {
    selector: `${sidebar} a[href$="/mcps"]`,
    title: "MCP connections",
    description:
      "Pick an MCP server from the catalog, or add your own. Grant it to an agent and the agent can call its tools.",
  },
  {
    selector: `${sidebar} a[href$="/sandboxes"]`,
    title: "Sandboxes",
    description:
      "A sandbox holds the model, skills, MCP tools, packages and allowed hosts. Agents inherit it, and you can swap it later.",
  },
  {
    selector: '[data-tour="inference"]',
    title: "Inference",
    description:
      "Add your model providers, then group them into pools. Bedrock, Vertex, Azure AI Foundry and custom endpoints all work.",
  },
  {
    selector: `${sidebar} a[href$="/secrets"]`,
    title: "Secrets",
    description:
      "Agents never see your credentials. AgentZ injects a placeholder, and the proxy swaps in the real value for hosts you allow.",
  },
  {
    selector: `${sidebar} a[href$="/workflows/graphs"]`,
    title: "Workflows",
    description:
      "Ask an agent to build a workflow for a task you repeat. Run it with typed fields or plain JSON.",
  },
  {
    selector: `${sidebar} a[href$="/workflows/triggers"]`,
    title: "Triggers",
    description: "Run a workflow on a schedule, or fire it from a webhook.",
  },
  {
    selector: `${sidebar} a[href$="/dashboards"]`,
    title: "Dashboards",
    description: "Ask an agent to publish a chart from its results. The charts collect here.",
  },
  {
    selector: '[data-tour="lens"]',
    title: "Lens",
    description:
      "Lens shows what actually happened. Read traces of agent runs, runtime telemetry and MCP activity.",
  },
  {
    selector: `${sidebar} a[href$="/roles"]`,
    title: "Roles",
    description: "Roles decide who can read, change and run each resource in this scope.",
  },
  {
    selector: `${sidebar} a[href$="/event-trail"]`,
    title: "Event trail",
    description: "An audit log of every change, with the actor, the resource and the time.",
  },
  {
    selector: `${sidebar} [data-sidebar="footer"]`,
    title: "Your account",
    description:
      "Switch organizations, open your account settings, or sign out. The tour button above replays this walkthrough.",
    align: "end",
  },
]
