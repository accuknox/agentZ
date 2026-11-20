import assert from "node:assert/strict"
import { test } from "node:test"
import { browserWindowLayout, resizeBrowserWindow } from "./browser-window-layout"

const area = { left: 200, top: 40, width: 1200, height: 800 }
const page = { width: 1280, height: 800 }
const preview = { left: 1068, top: 628, width: 320 }

test("dragging and resizing reserve a full-height conversation area to the left", () => {
  const initial = browserWindowLayout(area, page, preview)
  assert.equal(initial.left, preview.left)
  assert.equal(initial.top, preview.top)

  const frame = browserWindowLayout(area, page, { ...preview, left: -100, width: 500 })
  assert.ok(area.left + area.width - frame.insetRight < frame.left)
  assert.ok(area.width - frame.insetRight >= 640)
  assert.equal(frame.insetBottom, 0)
  assert.ok(frame.left + frame.width <= area.left + area.width)
})

test("narrow canvases reserve a separate preview strip without consuming the chat width", () => {
  const narrow = { left: 100, top: 80, width: 895, height: 700 }
  const frame = browserWindowLayout(narrow, page, { ...preview, top: -100, width: 2000 })
  assert.equal(frame.insetRight, 0)
  assert.ok(narrow.top + narrow.height - frame.insetBottom < frame.top)
  assert.ok(narrow.height - frame.insetBottom >= narrow.height / 2)
  assert.ok(frame.top + frame.height <= narrow.top + narrow.height)
})

test("portrait pages use a compact preview fitted to their aspect ratio", () => {
  const portrait = { width: 390, height: 844 }
  const frame = browserWindowLayout(area, portrait)
  assert.ok(frame.height <= 320)
  assert.ok(Math.abs(frame.width / frame.height - portrait.width / portrait.height) < 0.001)
})

test("resizing from the top-left preserves aspect ratio and the opposite corner", () => {
  const start = browserWindowLayout(area, page)
  const next = browserWindowLayout(area, page, resizeBrowserWindow(start, -1, -1, -96, -60))
  assert.equal(next.width, start.width + 96)
  assert.equal(next.height, start.height + 60)
  assert.equal(next.left + next.width, start.left + start.width)
  assert.equal(next.top + next.height, start.top + start.height)
})

test("growing the preview keeps chat beside it without a layout jump", () => {
  const compact = { ...area, width: 1000 }
  let frame = browserWindowLayout(compact, page)
  for (let width = frame.width + 1; width <= 620; width++) {
    const next = browserWindowLayout(compact, page, resizeBrowserWindow(frame, -1, 0, -1, 0))
    assert.equal(next.width, width)
    assert.equal(next.insetBottom, 0)
    assert.equal(next.insetRight - frame.insetRight, 1)
    assert.ok(compact.width - next.insetRight >= 360)
    frame = next
  }
})
