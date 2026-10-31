import { openDB, type DBSchema } from "idb"
import type { SessionMessagesResponse2 } from "@opencode-ai/sdk/v2"

type Preview = {
  key: string
  savedAt: number
  session: [string, string, string]
  records: SessionMessagesResponse2
}

interface ChatCache extends DBSchema {
  previews: {
    key: string
    value: Preview
    indexes: { savedAt: number; session: Preview["session"] }
  }
  lifecycle: { key: string; value: number }
}

let database: ReturnType<typeof openDB<ChatCache>> | undefined
let generation = 0

// Recent transcripts are disposable previews, never authority for permissions,
// running state, or sends. Keep them separate from Query's live history.
export const chatCache = {
  async read(key: string): Promise<SessionMessagesResponse2 | undefined> {
    try {
      const db = await open()
      const preview = await db.get("previews", key)
      if (!preview || Date.now() - preview.savedAt > 86_400_000) return
      return preview.records
    } catch {
      // Private mode, eviction and failed upgrades must not break chat.
      return undefined
    }
  },
  schedule(
    key: string,
    session: Preview["session"],
    records: SessionMessagesResponse2
  ): () => void {
    const version = generation
    // Capture intent before storage opens. A suspended tab can finish opening
    // its database after another tab has already cleared private previews.
    const requestedAt = Date.now()
    const timer = setTimeout(async () => {
      try {
        if (version !== generation) return
        const db = await open()
        // Only settled text is useful for an instant preview. Raw tool output,
        // images and approval state stay on the server and out of the disk cache.
        const settled = records
          .toSorted((a, b) => a.info.time.created - b.info.time.created)
          .slice(-40)
          .filter(
            ({ info }) =>
              info.role === "user" || (info.time.completed !== undefined && !info.summary)
          )
          .map(({ info, parts }) => ({
            info,
            parts: parts.filter(
              (part) =>
                part.type === "compaction" ||
                (part.type === "text" && !part.synthetic && !part.ignored)
            ),
          }))
        const bytes = new TextEncoder().encode(JSON.stringify(settled)).byteLength
        if (bytes > 250_000 || version !== generation) return
        const tx = db.transaction(["previews", "lifecycle"], "readwrite")
        if (((await tx.objectStore("lifecycle").get("epoch")) ?? 0) >= requestedAt) {
          await tx.done
          return
        }
        const store = tx.objectStore("previews")
        await store.put({ key, savedAt: Date.now(), session, records: settled })
        // A 250 KB entry limit and 32 entries bound storage at 8 MB. Read
        // index keys for eviction, never clone every cached transcript to JS.
        const index = store.index("savedAt")
        const expired = await index.getAllKeys(IDBKeyRange.upperBound(Date.now() - 86_400_000))
        const keys = await index.getAllKeys()
        const evicted = new Set([...expired, ...keys.slice(0, Math.max(0, keys.length - 32))])
        for (const key of evicted) await store.delete(key)
        await tx.done
      } catch {
        // A cache write can fail independently of the successful server request.
      }
    }, 1_000)
    return () => clearTimeout(timer)
  },
  async clear(session?: Preview["session"]): Promise<void> {
    generation += 1
    try {
      const db = await open()
      const tx = db.transaction(["previews", "lifecycle"], "readwrite")
      const epoch = (await tx.objectStore("lifecycle").get("epoch")) ?? 0
      await tx.objectStore("lifecycle").put(Math.max(epoch + 1, Date.now()), "epoch")
      const store = tx.objectStore("previews")
      if (session) {
        const keys = await store.index("session").getAllKeys(session)
        for (const key of keys) await store.delete(key)
      } else {
        await store.clear()
      }
      await tx.done
    } catch {
      // Storage may already be unavailable or cleared by the browser.
    }
  },
}

async function open() {
  if (!database) {
    database = openDB<ChatCache>("agentz-chat-previews", 2, {
      upgrade(db, oldVersion) {
        // Previews are disposable; older entries have no session index.
        if (oldVersion > 0) db.deleteObjectStore("previews")
        const store = db.createObjectStore("previews", { keyPath: "key" })
        store.createIndex("savedAt", "savedAt")
        store.createIndex("session", "session")
        if (oldVersion === 0) db.createObjectStore("lifecycle")
      },
      blocking() {
        void database?.then((db) => db.close())
        database = undefined
      },
      terminated() {
        database = undefined
      },
    }).catch((error) => {
      database = undefined
      throw error
    })
  }
  return database
}
