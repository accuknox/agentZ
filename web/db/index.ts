import "dotenv/config"
import { drizzle } from "drizzle-orm/node-postgres"
import * as schema from "@/db/auth-schema"
import { getEnv } from "@/lib/env"

export { schema }

let db: ReturnType<typeof drizzle> | undefined

/**
 * getDB opens the shared database client lazily so builds can import modules
 * without requiring runtime-only secrets.
 */
export function getDB() {
  db ??= drizzle(getEnv().DATABASE_URL, { schema })
  return db
}
