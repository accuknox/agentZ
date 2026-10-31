"use client"

import * as React from "react"
import {
  Modal,
  ModalPresence,
  ModalBackdrop,
  ModalPanel,
  useModalFocusRestoration,
} from "@/components/interior/modal"
import { Dialog as SheetPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

function SheetPortal({ ...props }: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      asChild
      forceMount
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-foreground/10 supports-backdrop-filter:backdrop-blur-xs",
        className
      )}
      {...props}
    >
      <ModalBackdrop />
    </SheetPrimitive.Overlay>
  )
}

const sheetWidths = {
  default: "sm:w-3/4 sm:max-w-sm",
  half: "sm:w-[50vw]",
  md: "sm:w-140",
  lg: "sm:w-180",
  full: "",
}

function SheetContent({
  className,
  children,
  onOpenAutoFocus,
  onCloseAutoFocus,
  style,
  side = "right",
  size = "default",
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: "top" | "right" | "bottom" | "left"
  size?: keyof typeof sheetWidths
}) {
  const focus = useModalFocusRestoration({ onOpenAutoFocus, onCloseAutoFocus })
  return (
    <ModalPresence>
      <SheetPortal forceMount>
        <SheetOverlay />
        <SheetPrimitive.Content
          {...focus}
          asChild
          forceMount
          data-slot="sheet-content"
          // Nested modal menus must dismiss against this panel, not the backdrop beneath it.
          style={{ pointerEvents: "auto", ...style }}
          data-side={side}
          className={cn(
            "fixed z-50 flex max-w-[100vw] flex-col gap-4 overscroll-contain bg-popover bg-clip-padding text-sm text-popover-foreground shadow-lg data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:border-r data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:border-l data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b",
            (side === "left" || side === "right") && ["w-full", sheetWidths[size]],
            className
          )}
          {...props}
        >
          <ModalPanel side={side}>
            {children}
            <SheetPrimitive.Close data-slot="sheet-close" asChild>
              <Button variant="ghost" className="absolute top-3 right-3" size="icon-sm">
                <XIcon />
                <span className="sr-only">Close</span>
              </Button>
            </SheetPrimitive.Close>
          </ModalPanel>
        </SheetPrimitive.Content>
      </SheetPortal>
    </ModalPresence>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex shrink-0 flex-col gap-0.5 border-b p-4 pr-12", className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  )
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("font-heading text-base font-medium text-foreground", className)}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export { Modal as Sheet, SheetContent, SheetHeader, SheetFooter, SheetTitle, SheetDescription }
