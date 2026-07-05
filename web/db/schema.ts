import { pgTable, text, boolean, timestamp } from "drizzle-orm/pg-core"
import { users } from "./auth-schema"

export * from "./auth-schema"

export const userPreferences = pgTable("user_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  updateSandbox: boolean("update_sandbox").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
})
