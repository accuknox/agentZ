import { test } from "node:test"
import assert from "node:assert/strict"
import { Control } from "./control.ts"

test("takeover fences queued agent mutations and waits for in-flight work", async () => {
  const control = new Control()
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const running = control.run(null, async () => {
    started.resolve()
    await finish.promise
  })
  await started.promise
  let submitted = false
  const queued = control.run(null, async () => {
    submitted = true
  })
  const rejected = assert.rejects(queued, /control changed/)
  const takeover = control.take("viewer")
  finish.resolve()
  await Promise.all([running, takeover, rejected])
  assert.equal(submitted, false)
  await assert.rejects(
    control.run(null, async () => {}),
    /control changed/
  )
  await control.run("viewer", async () => {})
  await control.release("viewer")
  await control.run(null, async () => {})
})
