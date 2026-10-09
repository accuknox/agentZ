import assert from "node:assert/strict"
import { test } from "node:test"
import type { z } from "zod"
import { oauthApplicationInput } from "./schema"

const browser = {
  name: "Browser",
  type: "browser",
  redirectUris: ["https://app.example/callback"],
  scopes: ["openid"],
  authorizedOrigins: ["https://app.example"],
} satisfies z.input<typeof oauthApplicationInput>

test("browser origins are canonical, distinct, and independent of callbacks", () => {
  const result = oauthApplicationInput.parse({
    ...browser,
    authorizedOrigins: [
      "https://APP.example:443/",
      "https://app.example",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://[::1]:5173",
    ],
  })
  assert.deepEqual(result.authorizedOrigins, [
    "https://app.example",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://[::1]:5173",
  ])
  assert.deepEqual(result.redirectUris, browser.redirectUris)
})

test("browser origins reject ambiguous URLs and insecure remote origins", () => {
  for (const origin of [
    "null",
    "*",
    "https://*.example",
    "https://%2a.example",
    "https://app.example/path",
    "https://app.example?",
    "https://app.example#",
    "https://user@app.example",
    "https://@app.example",
    "https://:@app.example",
    "https://app.example\\",
    "https://app.example\n",
    "https://app.example\u0001",
    "https://app.example\u007f",
    "http://app.example",
    "http://localhost.evil",
    "http://localhost.",
    "http://127.1",
    "http://2130706433",
    "http://0x7f000001",
    "http://%6cocalhost",
    "file:///",
    "https://app.example https://other.example",
  ]) {
    assert.equal(
      oauthApplicationInput.safeParse({ ...browser, authorizedOrigins: [origin] }).success,
      false,
      origin
    )
  }
})

test("only browser clients register origins, with one to ten entries", () => {
  assert.equal(
    oauthApplicationInput.safeParse({ ...browser, authorizedOrigins: [] }).success,
    false
  )
  assert.equal(
    oauthApplicationInput.safeParse({
      ...browser,
      authorizedOrigins: Array.from({ length: 11 }, (_, i) => `https://app${i}.example`),
    }).success,
    false
  )
  for (const type of ["native", "confidential"]) {
    assert.equal(oauthApplicationInput.safeParse({ ...browser, type }).success, false)
    assert.equal(
      oauthApplicationInput.safeParse({ ...browser, type, authorizedOrigins: [] }).success,
      true
    )
  }
  assert.equal(
    oauthApplicationInput.safeParse({ ...browser, redirectUris: ["https://app.example/callback#"] })
      .success,
    false
  )
})

test("browser callbacks reject insecure hosts and ambiguous URLs", () => {
  for (const uri of [
    "invalid URL",
    "http://app.example/callback",
    "http://localhost.evil/callback",
    "http://localhost./callback",
    "http://127.1/callback",
    "http://2130706433/callback",
    "http://0x7f000001/callback",
    "http://%6cocalhost/callback",
    "http://[0:0:0:0:0:0:0:1]/callback",
    "http://user:password@localhost/callback",
    "http://@localhost/callback",
    "http://localhost/callback#",
    "http://localhost/callback*",
    "http://localhost/callback\\other",
    "http://localhost/callback\n",
    "http://localhost/callback\u0001",
    "http://localhost/callback\u007f",
  ]) {
    assert.equal(
      oauthApplicationInput.safeParse({ ...browser, redirectUris: [uri] }).success,
      false,
      uri
    )
  }
})
