/** @type {import('@hey-api/openapi-ts').UserConfig} */
const config = {
  input: "../openapi/base.yaml",
  output: {
    path: "lib/gateway/client",
    postProcess: ["eslint", "prettier"],
    tsConfigPath: "tsconfig.json",
  },
  plugins: [
    {
      name: "@hey-api/sdk",
      operations: {
        strategy: "flat",
      },
      validator: {
        request: false,
      },
    },
    {
      name: "zod",
      requests: false,
      "~resolvers": {
        string(ctx) {
          if (ctx.schema.format !== "markdown" || ctx.schema.maxLength === undefined) return
          const { $, schema } = ctx
          // OpenAPI lengths count Unicode code points; Zod's .max counts UTF-16 units.
          return ctx.nodes
            .base(ctx)
            .attr("refine")
            .call(
              $.func()
                .param("value")
                .do(
                  $.binary(
                    $("Array").attr("from").call($("value")).attr("length"),
                    "<=",
                    $.literal(schema.maxLength)
                  ).return()
                ),
              $.object().prop(
                "error",
                $.literal(`Custom instructions must be at most ${schema.maxLength} characters`)
              )
            )
        },
      },
    },
    { name: "@hey-api/client-next", runtimeConfigPath: "@/lib/gateway/hey-api" },
    "@tanstack/react-query",
  ],
}

export default config
