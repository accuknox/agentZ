import { getAuth } from "@/lib/auth"
import { toNextJsHandler } from "better-auth/next-js"

/**
 * GET serves Better Auth requests without instantiating the auth stack during
 * build-time module evaluation.
 */
export async function GET(request: Request): Promise<Response> {
  return toNextJsHandler(getAuth()).GET(request)
}

/**
 * POST serves Better Auth requests without instantiating the auth stack during
 * build-time module evaluation.
 */
export async function POST(request: Request): Promise<Response> {
  return toNextJsHandler(getAuth()).POST(request)
}
