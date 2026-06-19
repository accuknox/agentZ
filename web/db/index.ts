import "dotenv/config"
import { drizzle } from "drizzle-orm/node-postgres"
import * as schema from "@/db/auth-schema"
import { env } from "@/lib/env"

export { schema }

export const db = drizzle(env.DATABASE_URL, { schema })
