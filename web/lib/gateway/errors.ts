/**
 * GATEWAY_UNAUTHORIZED is the error message that survives the Server Action
 * boundary. instanceof is unreliable there (errors are reconstructed as plain
 * Error on the client), so client interceptors match on error.message ===
 * GATEWAY_UNAUTHORIZED instead.
 */
export const GATEWAY_UNAUTHORIZED = "GATEWAY_UNAUTHORIZED" as const

/**
 * GatewayUnauthorizedError is thrown from currentGatewayAuthToken when
 * the session is missing or revoked, instead of calling redirect().
 * redirect() throws NEXT_REDIRECT which the hey-api SDK's request()
 * try/catch swallows; this error is converted back to a redirect() by
 * the error interceptor (which runs inside the SDK's catch, so its
 * throw escapes cleanly).
 */
export class GatewayUnauthorizedError extends Error {
  constructor() {
    super(GATEWAY_UNAUTHORIZED)
    this.name = "GatewayUnauthorizedError"
  }
}
