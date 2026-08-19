# Sandboxes

Sandboxes are a set of allowed hosts and software packages. They are reusable,
so multiple agents can reference the same Sandbox. Each agent must reference
exactly 1 Sandbox.

Sandboxes solve a common problem in AI agent deployment: how to give agents
the tools they need without giving them unrestricted access to the system.

By separating Sandbox from Agent, you can:

- Create a library of pre-configured Sandboxes (e.g., "Data analysis")
- Update a Sandbox and have all referencing Agents automatically use the
  new configuration
