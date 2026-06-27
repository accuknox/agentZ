import type { PluginModule } from "@opencode-ai/plugin"

const plugin: PluginModule = {
  id: "clawarmor-skill-reload",
  server: async ({ client }) => {
    let disposing = false

    return {
      event: async ({ event }) => {
        if (event.type !== "session.created" || disposing) {
          return
        }

        disposing = true
        try {
          await client.instance.dispose()
          console.info("[clawarmor:skill-reload] disposed instance after session.created")
        } catch (error) {
          disposing = false
          console.error(
            "[clawarmor:skill-reload] failed to dispose instance after session.created",
            error
          )
        }
      },
    }
  },
}

export default plugin
