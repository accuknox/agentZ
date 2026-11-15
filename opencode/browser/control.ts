// Reservations fence queued input before a new controller begins operating.
export class Control {
  generation = 0
  viewer: string | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false

  run<T>(viewer: string | null, action: () => Promise<T>, deadline = Infinity): Promise<T> {
    const generation = this.generation
    const result = this.tail.then(() => {
      if (this.closed || generation !== this.generation || viewer !== this.viewer) {
        throw new Error("Browser control changed. Refresh the page before trying again.")
      }
      if (Date.now() >= deadline) throw new Error("Browser action expired before it could start")
      return action()
    })
    this.tail = result.catch(() => {})
    return result
  }

  async take(viewer: string) {
    if (this.viewer && this.viewer !== viewer) throw new Error("Another viewer controls this tab")
    this.viewer = viewer
    this.generation++
    await this.tail
  }

  async release(viewer: string) {
    if (this.viewer !== viewer) throw new Error("Only the controlling viewer can release this tab")
    this.viewer = null
    this.generation++
    await this.tail
  }

  async close() {
    this.closed = true
    this.generation++
    await this.tail
  }
}
