import assert from "node:assert/strict"
import { test } from "node:test"
import { browserWindowLayout } from "./browser-window-layout"

const area = { left: 200, top: 40, width: 1200, height: 800 }
const preview = { left: 1068, top: 628, width: 320, height: 200 }

test("dragging left shrinks the chat and stops before its minimum width", () => {
  const moved = browserWindowLayout(area, { ...preview, left: 800 })
  assert.equal(moved.insetRight, 612)
  const clamped = browserWindowLayout(area, { ...preview, left: -100, top: -100 })
  assert.equal(area.width - clamped.insetRight, 320)
  assert.equal(clamped.left, area.left + 332)
  assert.equal(clamped.top, area.top + 56)
})

test("an oversized preview stays inside the canvas and leaves room for chat", () => {
  const frame = browserWindowLayout(area, { ...preview, width: 2000, height: 2000 })
  assert.equal(frame.left + frame.width, area.left + area.width - 12)
  assert.equal(frame.top + frame.height, area.top + area.height - 12)
  assert.equal(area.width - frame.insetRight, 320)
})

test("narrow screens reserve space below the working area", () => {
  const narrow = { left: 0, top: 0, width: 390, height: 700 }
  const frame = browserWindowLayout(narrow, preview)
  assert.equal(frame.insetRight, 0)
  assert.equal(narrow.height - frame.insetBottom + 12, frame.top)
  assert.ok(frame.left + frame.width <= narrow.width - 12)
  assert.ok(frame.top + frame.height <= narrow.height - 12)
  assert.ok(narrow.height - frame.insetBottom >= narrow.height / 2 - 12)
})
