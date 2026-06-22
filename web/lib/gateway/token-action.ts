"use server"

import { currentGatewayAuthToken } from "@/lib/gateway/auth"

export async function getGatewayToken(returnTo?: string): Promise<string> {
  return currentGatewayAuthToken(returnTo)
}
