import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <div className="flex flex-col gap-4" role="status">
      <span className="sr-only">Loading event trail events...</span>
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-36 w-full" />
      <Skeleton className="h-96 w-full" />
    </div>
  )
}
