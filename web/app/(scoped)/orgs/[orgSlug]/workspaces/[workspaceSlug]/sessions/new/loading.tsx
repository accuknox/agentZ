import { Skeleton } from "@/components/ui/skeleton"

export default function NewChatLoading() {
  return (
    <main className="grid h-full min-h-0 flex-1 place-items-center px-4">
      <div className="w-full max-w-3xl space-y-8">
        <Skeleton className="mx-auto h-10 w-2/3" />
        <Skeleton className="h-44 w-full rounded-2xl" />
      </div>
    </main>
  )
}
