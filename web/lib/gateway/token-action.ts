"use server"

import { currentGatewayAuthToken } from "@/lib/gateway/auth"

export async function getGatewayToken(): Promise<string> {
  return currentGatewayAuthToken()
}
