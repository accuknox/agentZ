import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  encodeSelectionHistory,
  readSelectionHistory,
  rememberSelection,
  restoreSelection,
  selectionCookie,
  selectionURL,
  type SelectionHistory,
} from "./page-selection"

const scope = JSON.stringify(["user", "organization", "workspace"])
const history: SelectionHistory = [
  [scope, "workflows/graphs", { agent_name: "b", workflow_name: "b-two" }],
  [scope, "workflows/graphs", { agent_name: "a", workflow_name: "a-two" }],
  [
    scope,
    "workflows/triggers/runs",
    { agent_name: "b", type: "webhook", workflow_name: "b-two", webhook_api_key_id: "key" },
  ],
  [
    scope,
    "workflows/triggers/runs",
    { agent_name: "b", type: "schedule", workflow_name: "b-one", schedule_name: "daily" },
  ],
]

describe("selection restoration", () => {
  test("keeps pages, accounts, workspaces and parent histories independent", () => {
    assert.deepEqual(restoreSelection(history, scope, "workflows/graphs", {}), {
      agent_name: "b",
      workflow_name: "b-two",
    })
    assert.deepEqual(restoreSelection(history, scope, "workflows/graphs", { agent_name: "a" }), {
      agent_name: "a",
      workflow_name: "a-two",
    })
    assert.equal(
      restoreSelection(history, "another scope", "workflows/graphs", {}).agent_name,
      undefined
    )
    assert.equal(restoreSelection(history, scope, "secrets", {}).agent_name, undefined)
    assert.equal(
      restoreSelection(history, scope, "workflows/graphs", { agent_name: "c" }).workflow_name,
      undefined
    )
  })

  test("explicit links win, including invalid and explicitly empty values", () => {
    assert.equal(
      restoreSelection(history, scope, "workflows/graphs", {
        agent_name: "b",
        workflow_name: "explicit",
      }).workflow_name,
      "explicit"
    )
    assert.equal(
      restoreSelection(history, scope, "workflows/graphs", { agent_name: "" }).agent_name,
      ""
    )
    assert.equal(
      restoreSelection(history, scope, "workflows/graphs", { agent_name: "deleted" }).workflow_name,
      undefined
    )
  })

  test("restores the trigger kind before its composite identity", () => {
    assert.deepEqual(restoreSelection(history, scope, "workflows/triggers/runs", {}), {
      agent_name: "b",
      type: "webhook",
      workflow_name: "b-two",
      webhook_api_key_id: "key",
    })
    assert.deepEqual(
      restoreSelection(history, scope, "workflows/triggers/runs", {
        agent_name: "b",
        type: "schedule",
      }),
      { agent_name: "b", type: "schedule", workflow_name: "b-one", schedule_name: "daily" }
    )
    assert.equal(
      restoreSelection(history, scope, "workflows/triggers/runs", {
        agent_name: "b",
        type: "webhook",
        workflow_name: "explicit",
      }).webhook_api_key_id,
      undefined
    )
  })

  test("replaces only the selected parent's child and removes confirmed missing branches", () => {
    const updated = rememberSelection(
      history,
      scope,
      "workflows/graphs",
      { agent_name: "a", workflow_name: "a-three" },
      { agent_name: "a", workflow_name: "a-three" }
    )
    assert.equal(restoreSelection(updated, scope, "workflows/graphs", {}).workflow_name, "a-three")
    assert.equal(
      restoreSelection(updated, scope, "workflows/graphs", { agent_name: "b" }).workflow_name,
      "b-two"
    )
    const repaired = rememberSelection(
      updated,
      scope,
      "workflows/graphs",
      { agent_name: "b", workflow_name: "b-one" },
      { agent_name: "a", workflow_name: "a-three" }
    )
    assert.equal(
      restoreSelection(repaired, scope, "workflows/graphs", { agent_name: "a" }).workflow_name,
      undefined
    )
    assert.equal(restoreSelection(repaired, scope, "workflows/triggers/runs", {}).type, "webhook")
  })

  test("empty options clear the invalid branch without inventing a selection", () => {
    const next = rememberSelection(
      history,
      scope,
      "workflows/graphs",
      {},
      { agent_name: "b", workflow_name: "b-two" }
    )
    assert.equal(
      next.some(([, page, value]) => page === "workflows/graphs" && value.agent_name === "b"),
      false
    )
    assert.equal(
      next.some(([, page, value]) => page === "workflows/graphs" && value.agent_name === "a"),
      true
    )
  })
})

describe("bounded browser storage", () => {
  test("round trips identifiers and rejects malformed data at the boundary", () => {
    assert.deepEqual(readSelectionHistory(encodeSelectionHistory(history)), history)
    for (const raw of [
      undefined,
      "%",
      "{}",
      "%5B42%5D",
      encodeURIComponent(JSON.stringify([[scope, "unknown", {}]])),
      "x".repeat(4000),
    ]) {
      assert.deepEqual(readSelectionHistory(raw), [])
    }
  })

  test("evicts oldest history using encoded bytes, retaining the newest fitting entry", () => {
    const large: SelectionHistory = Array.from({ length: 100 }, (_, index) => [
      scope,
      "workflows/graphs",
      { agent_name: `agent-${index}`, workflow_name: "世界".repeat(15) },
    ])
    const encoded = encodeSelectionHistory(large)
    assert.ok(encoded.length + selectionCookie.length <= 3500)
    const decoded = readSelectionHistory(encoded)
    assert.ok(decoded.length > 0)
    assert.ok(decoded.length < large.length)
    assert.deepEqual(decoded[0], large[0])
    assert.equal(large.length, 100)
  })
})

test("selection URLs remove old descendants and cursors while preserving unrelated filters", () => {
  const search = new URLSearchParams(
    "agent_name=a&workflow_name=old&run_name=old&page_token=p&token_stack=s&telemetry_page_token=t&telemetry_token_stack=u&from=2026-09-01&sort_by=name"
  )
  const url = selectionURL("/page", search, { agent_name: "b", workflow_name: "new" }, true)
  assert.equal(url, "/page?from=2026-09-01&sort_by=name&agent_name=b&workflow_name=new")
  assert.equal(search.get("page_token"), "p")
})
