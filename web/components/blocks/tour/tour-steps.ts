export type TourStep = {
  /** CSS selector for the element to highlight. Omit for a centered modal step. */
  selector?: string
  title: string
  description: string
  side?: "top" | "right" | "bottom" | "left"
  align?: "start" | "center" | "end"
}

const sidebar = "[data-app-sidebar]"

/**
 * Ordered tour of the product. Steps whose selector matches nothing in the
 * current DOM are dropped before the tour starts, so one list covers the
 * account, organization and workspace scopes.
 */
export const tourSteps: TourStep[] = [
  {
    title: "Welcome to AgentZ",
    description:
      "This short tour points at the parts of the sidebar you use most. Use Next and Back to move, Skip tour or the close button to leave at any time.",
  },
  {
    selector: `${sidebar} [data-sidebar="header"]`,
    title: "Organization and workspace",
    description:
      "Switch between organizations and workspaces here. A workspace holds its own agents, skills, connections and inference settings.",
    side: "right",
    align: "start",
  },
  {
    selector: '[data-tour="new-chat"]',
    title: "Start a chat",
    description:
      "Open a new chat with an agent. Every chat runs against the agent, model and tools configured in this workspace.",
    side: "right",
    align: "start",
  },
  {
    selector: '[data-tour="sessions"]',
    title: "Your chat history",
    description:
      "Past chats and workflow runs are listed here. Search them, group them, or filter by agent and participant.",
    side: "right",
    align: "start",
  },
  {
    selector: `${sidebar} a[href$="/agents"]`,
    title: "Agents",
    description:
      "Agents are the assistants of the workspace. Each one carries its own instructions, permissions, skills and tools.",
    side: "right",
    align: "start",
  },
  {
    selector: `${sidebar} a[href$="/skills"]`,
    title: "Skills",
    description:
      "Skills are reusable instruction packs. Attach a skill to an agent to teach it a task without changing its prompt.",
    side: "right",
    align: "start",
  },
  {
    selector: `${sidebar} a[href$="/mcps"]`,
    title: "MCP connections",
    description:
      "Connect external tools and data over the Model Context Protocol. An agent can call any connection you grant it.",
    side: "right",
    align: "start",
  },
  {
    selector: `${sidebar} a[href$="/sandboxes"]`,
    title: "Sandboxes",
    description:
      "Sandboxes are the isolated containers where agents run commands and edit files. Set the image and the resource limits here.",
    side: "right",
    align: "start",
  },
  {
    selector: '[data-tour="inference"]',
    title: "Inference",
    description:
      "Register model providers and group them into pools. A pool decides which model an agent gets, and what the fallback is.",
    side: "right",
    align: "start",
  },
  {
    selector: `${sidebar} a[href$="/secrets"]`,
    title: "Secrets",
    description:
      "Store API keys and tokens once, then reference them from agents and connections. Values stay write-only after you save them.",
    side: "right",
    align: "start",
  },
  {
    selector: `${sidebar} a[href$="/workflows/graphs"]`,
    title: "Workflows",
    description: "Chain agents into a graph so a multi-step job runs the same way every time.",
    side: "right",
    align: "start",
  },
  {
    selector: `${sidebar} a[href$="/workflows/triggers"]`,
    title: "Triggers",
    description: "Run a workflow on a schedule or on an incoming event, with no one in the loop.",
    side: "right",
    align: "start",
  },
  {
    selector: `${sidebar} a[href$="/dashboards"]`,
    title: "Dashboards",
    description:
      "Charts your agents publish, kept in one place so you can watch results over time.",
    side: "right",
    align: "start",
  },
  {
    selector: '[data-tour="lens"]',
    title: "Lens",
    description:
      "Lens is the observability view. Read traces of agent runs, runtime telemetry and MCP activity when you need to know what happened.",
    side: "right",
    align: "start",
  },
  {
    selector: `${sidebar} a[href$="/roles"]`,
    title: "Roles",
    description: "Roles decide who can read, change and run each resource in this scope.",
    side: "right",
    align: "start",
  },
  {
    selector: `${sidebar} a[href$="/event-trail"]`,
    title: "Event trail",
    description: "An audit log of every change, with the actor, the resource and the time.",
    side: "right",
    align: "start",
  },
  {
    selector: `${sidebar} [data-sidebar="footer"]`,
    title: "Your account",
    description:
      "Switch organizations, open account settings and API keys, or sign out. The tour button sits right above it whenever you want to run this again.",
    side: "right",
    align: "end",
  },
  {
    title: "That is the tour",
    description:
      "Open the rocket button in the sidebar footer to replay it. Full documentation lives at docs.accuknox.com.",
  },
]
