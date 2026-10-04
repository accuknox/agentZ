"use server"

import { revalidatePath } from "next/cache"
import { disconnectOAuthApplication } from "@/data/delegations"

export async function disconnectApplicationAction(clientId: string) {
  try {
    await disconnectOAuthApplication(clientId)
    revalidatePath("/settings/applications")
    return { disconnected: true }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "The application could not be disconnected.",
    }
  }
}
