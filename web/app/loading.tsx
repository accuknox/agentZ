import { Progress } from "@/components/ui/progress"

export default function Loading() {
  return (
    <Progress
      aria-hidden="true"
      value={0}
      className="navigation-progress fixed inset-x-0 top-0 z-50 h-0.5 rounded-none bg-transparent"
    />
  )
}
