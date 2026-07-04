/**
 * Loading renders a stable skeleton while the MCP graph route streams.
 */
export default function Loading() {
  return (
    <main className="flex flex-1 flex-col gap-0 p-0">
      <div className="flex items-center justify-between px-4 sm:px-6">
        <div className="min-w-0">
          <h1 className="text-base font-medium tracking-normal">MCP Observability</h1>
        </div>
      </div>
      <div className="bg-muted/20 h-15 border-b" />
      <div className="flex flex-1 px-4 py-6 sm:px-6">
        <div className="bg-muted/20 min-h-105 w-full rounded-xl border" />
      </div>
    </main>
  )
}
