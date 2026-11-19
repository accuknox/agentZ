import assert from "node:assert/strict"
import { test } from "node:test"
import { browserWindowLayout } from "./browser-window-layout"

const area = { left: 200, top: 40, width: 1200, height: 800 }
const preview = { left: 1068, top: 628, width: 320, height: 200 }
const composer = { left: 360, top: 638, width: 640, height: 190 }

test("a floating preview fits beside the composer when there is room", () => {
  const frame = browserWindowLayout(area, preview, composer)
  assert.equal(frame.left, preview.left)
  assert.equal(frame.top, preview.top)
})

test("dragging into the composer moves the preview above it", () => {
  const frame = browserWindowLayout(area, { ...preview, left: 800 }, composer)
  assert.equal(frame.left, 800)
  assert.equal(frame.top + frame.height, composer.top - 12)
})

test("a growing composer limits the preview height on narrow screens", () => {
  const narrow = { left: 0, top: 0, width: 390, height: 700 }
  const expanded = { left: 12, top: 152, width: 366, height: 536 }
  const frame = browserWindowLayout(narrow, preview, expanded)
  assert.equal(frame.top + frame.height, expanded.top - 12)
  assert.ok(frame.left + frame.width <= narrow.width - 12)
})
