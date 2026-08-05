"use client"

import { useState, type ReactNode } from "react"
import { useRouter } from "@bprogress/next/app"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"

export function AuditDrawer({ children }: { children: ReactNode }) {
  const router = useRouter()
  const [open, setOpen] = useState(true)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        className="h-full overflow-hidden sm:w-[35rem]! sm:max-w-none!"
        onAnimationEnd={() => {
          if (open) return

          router.back()
          // Parallel route state survives history traversal. Reset it after
          // the closing animation so Forward can reveal the cached drawer.
          setOpen(true)
        }}
      >
        <SheetHeader className="shrink-0 border-b">
          <SheetTitle>Audit event</SheetTitle>
          <SheetDescription>Organisation mutation and governance evidence.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">{children}</div>
      </SheetContent>
    </Sheet>
  )
}
