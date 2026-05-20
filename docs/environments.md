# Environments

Environments are a set of allowed hosts and software packages. They are
reusable i.e. multiple agents can reference the same Environment. Each agent
must reference exactly 1 Environment.

Environments solve a common problem in AI agent deployment: how to give agents
the tools they need without giving them unrestricted access to the system.

By separating Environment from Agent, you can:

- Create a library of pre-configured Environments (e.g., "Data analysis")
- Update an Environment and have all referencing Agents automatically use the
  new configuration
