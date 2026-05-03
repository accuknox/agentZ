"use client"

import { InputGroup, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import type { ChatStatus } from "ai"
import { CornerDownLeftIcon, SquareIcon, XIcon } from "lucide-react"
import type {
  ComponentProps,
  FormEvent,
  FormEventHandler,
  HTMLAttributes,
  KeyboardEventHandler,
  MouseEvent,
} from "react"
import { useCallback, useState } from "react"

export interface PromptInputMessage {
  text: string
}

export type PromptInputProps = Omit<HTMLAttributes<HTMLFormElement>, "onSubmit" | "onError"> & {
  onSubmit: (message: PromptInputMessage, event: FormEvent<HTMLFormElement>) => void | Promise<void>
}

export const PromptInput = ({ className, onSubmit, children, ...props }: PromptInputProps) => {
  const handleSubmit: FormEventHandler<HTMLFormElement> = useCallback(
    async (event) => {
      event.preventDefault()

      const form = event.currentTarget
      const formData = new FormData(form)
      const text = (formData.get("message") as string | null) ?? ""
      const result = onSubmit({ text }, event)

      if (result instanceof Promise) {
        await result
      }

      form.reset()
    },
    [onSubmit]
  )

  return (
    <form className={cn("w-full", className)} onSubmit={handleSubmit} {...props}>
      <InputGroup
        className={cn(
          "min-h-16 overflow-hidden rounded-none border-x-0 border-t border-b-0",
          "border-border bg-background shadow-none",
          "has-[[data-slot=input-group-control]:focus-visible]:border-chat-user",
          "has-[[data-slot=input-group-control]:focus-visible]:ring-0"
        )}
      >
        {children}
      </InputGroup>
    </form>
  )
}

export type PromptInputTextareaProps = ComponentProps<typeof InputGroupTextarea>

export const PromptInputTextarea = ({
  onChange,
  onKeyDown,
  className,
  placeholder = "What would you like to know?",
  ...props
}: PromptInputTextareaProps) => {
  const [isComposing, setIsComposing] = useState(false)

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback(
    (event) => {
      onKeyDown?.(event)
      if (event.defaultPrevented) {
        return
      }
      if (event.key !== "Enter" || event.shiftKey) {
        return
      }
      if (isComposing || event.nativeEvent.isComposing) {
        return
      }

      event.preventDefault()

      const submitButton = event.currentTarget.form?.querySelector(
        'button[type="submit"]'
      ) as HTMLButtonElement | null
      if (submitButton?.disabled) {
        return
      }

      event.currentTarget.form?.requestSubmit()
    },
    [isComposing, onKeyDown]
  )

  return (
    <InputGroupTextarea
      className={cn(
        "field-sizing-content max-h-48 min-h-16 px-5 py-4 pr-16 font-mono text-[0.95rem]",
        "leading-7 placeholder:text-muted-foreground/65",
        className
      )}
      name="message"
      onChange={onChange}
      onCompositionEnd={() => setIsComposing(false)}
      onCompositionStart={() => setIsComposing(true)}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      {...props}
    />
  )
}

export type PromptInputSubmitProps = ComponentProps<typeof InputGroupButton> & {
  status?: ChatStatus
  onStop?: () => void
}

export const PromptInputSubmit = ({
  className,
  variant = "default",
  size = "icon-sm",
  status,
  onStop,
  onClick,
  children,
  ...props
}: PromptInputSubmitProps) => {
  const isGenerating = status === "submitted" || status === "streaming"

  let icon = <CornerDownLeftIcon className="size-4" />

  if (status === "submitted") {
    icon = <Spinner />
  } else if (status === "streaming") {
    icon = <SquareIcon className="size-4" />
  } else if (status === "error") {
    icon = <XIcon className="size-4" />
  }

  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      if (isGenerating && onStop) {
        event.preventDefault()
        onStop()
        return
      }
      onClick?.(event)
    },
    [isGenerating, onClick, onStop]
  )

  return (
    <InputGroupButton
      aria-label={isGenerating ? "Stop" : "Submit"}
      className={cn("rounded-none text-muted-foreground hover:text-foreground", className)}
      onClick={handleClick}
      size={size}
      type={isGenerating && onStop ? "button" : "submit"}
      variant={variant}
      {...props}
    >
      {children ?? icon}
    </InputGroupButton>
  )
}
