"use client"

import * as React from "react"
import {
  Modal,
  ModalPresence,
  ModalBackdrop,
  ModalPanel,
  useModalFocusRestoration,
} from "@/components/interior/modal"
import { Dialog as DialogPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      asChild
      forceMount
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-foreground/10 supports-backdrop-filter:backdrop-blur-xs",
        className
      )}
      {...props}
    >
      <ModalBackdrop />
    </DialogPrimitive.Overlay>
  )
}

function DialogContent({
  className,
  children,
  onKeyDown,
  onOpenAutoFocus,
  onCloseAutoFocus,
  style,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
  const focus = useModalFocusRestoration({ onOpenAutoFocus, onCloseAutoFocus })
  return (
    <ModalPresence>
      <DialogPortal forceMount>
        <DialogOverlay />
        <DialogPrimitive.Content
          {...focus}
          asChild
          forceMount
          data-slot="dialog-content"
          // Nested modal menus must dismiss against this panel, not the backdrop beneath it.
          style={{ pointerEvents: "auto", ...style }}
          className={cn(
            "fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto overscroll-contain rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 outline-none sm:max-w-sm",
            className
          )}
          onKeyDown={(event) => {
            onKeyDown?.(event)
            if (
              event.defaultPrevented ||
              event.key !== "Enter" ||
              event.nativeEvent.isComposing ||
              !(event.target instanceof HTMLInputElement) ||
              event.target.form
            ) {
              return
            }

            const submit = event.currentTarget.querySelector<HTMLButtonElement>(
              "[data-dialog-submit]:not(:disabled)"
            )
            if (submit) {
              event.preventDefault()
              submit.click()
            }
          }}
          {...props}
        >
          <ModalPanel>
            {children}
            <DialogPrimitive.Close data-slot="dialog-close" asChild>
              <Button variant="ghost" className="absolute top-2 right-2" size="icon-sm">
                <XIcon />
                <span className="sr-only">Close</span>
              </Button>
            </DialogPrimitive.Close>
          </ModalPanel>
        </DialogPrimitive.Content>
      </DialogPortal>
    </ModalPresence>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 pr-8", className)}
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  )
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("font-heading text-base leading-none font-medium", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Modal as Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
}
