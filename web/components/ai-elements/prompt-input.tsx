"use client"

import { InputGroup, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { ChatStatus, FileUIPart } from "ai"
import { ArrowUpIcon, SquareIcon, XIcon } from "lucide-react"
import { nanoid } from "nanoid"
import type {
  ChangeEventHandler,
  ClipboardEventHandler,
  ComponentProps,
  FormEvent,
  FormEventHandler,
  HTMLAttributes,
  KeyboardEventHandler,
  ReactNode,
} from "react"
import {
  Children,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

type PromptInputFile = FileUIPart & {
  size?: number
}

const convertBlobUrlToDataUrl = async (url: string): Promise<string | null> => {
  try {
    const response = await fetch(url)
    const blob = await response.blob()
    // FileReader uses callback-based API, wrapping in Promise is necessary
    // oxlint-disable-next-line eslint-plugin-promise(avoid-new)
    return new Promise((resolve) => {
      const reader = new FileReader()
      // oxlint-disable-next-line eslint-plugin-unicorn(prefer-add-event-listener)
      reader.onloadend = () => resolve(typeof reader.result === "string" ? reader.result : null)
      // oxlint-disable-next-line eslint-plugin-unicorn(prefer-add-event-listener)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

interface AttachmentsContext {
  files: (PromptInputFile & { id: string })[]
  add: (files: File[] | FileList) => void
  remove: (id: string) => void
  clear: () => void
  openFileDialog: () => void
}

type PromptInputLayoutContextValue = {
  isMultiline: boolean
  setMultiline: (value: boolean) => void
}

const PromptInputLayoutContext = createContext<PromptInputLayoutContextValue | null>(null)

const LocalAttachmentsContext = createContext<AttachmentsContext | null>(null)

function isFocusableControl(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) return false

  if (node.isContentEditable) return true

  const tagName = node.tagName
  if (
    tagName === "A" ||
    tagName === "BUTTON" ||
    tagName === "INPUT" ||
    tagName === "SELECT" ||
    tagName === "TEXTAREA"
  ) {
    return true
  }

  if (node.tabIndex >= 0) return true

  const role = node.getAttribute("role")
  if (
    role === "button" ||
    role === "combobox" ||
    role === "dialog" ||
    role === "link" ||
    role === "listbox" ||
    role === "menu" ||
    role === "menuitem" ||
    role === "option"
  ) {
    return true
  }

  return false
}

export const usePromptInputAttachments = () => {
  const context = useContext(LocalAttachmentsContext)
  if (!context) {
    throw new Error("usePromptInputAttachments must be used within a PromptInput")
  }
  return context
}

export interface PromptInputMessage {
  text: string
  files: PromptInputFile[]
}

type PromptInputProps = Omit<HTMLAttributes<HTMLFormElement>, "onSubmit" | "onError"> & {
  accept?: string
  multiple?: boolean
  globalDrop?: boolean
  maxFiles?: number
  maxFileSize?: number
  onError?: (err: { code: "max_files" | "max_file_size" | "accept"; message: string }) => void
  onSubmit: (message: PromptInputMessage, event: FormEvent<HTMLFormElement>) => void | Promise<void>
}

export const PromptInput = ({
  className,
  accept,
  multiple,
  globalDrop,
  maxFiles,
  maxFileSize,
  onError,
  onSubmit,
  children,
  ...props
}: PromptInputProps) => {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const formRef = useRef<HTMLFormElement | null>(null)
  const [items, setItems] = useState<(PromptInputFile & { id: string })[]>([])
  const [isDraggingFiles, setIsDraggingFiles] = useState(false)
  const [isMultiline, setIsMultiline] = useState(false)
  const filesRef = useRef(items)

  useEffect(() => {
    filesRef.current = items
  }, [items])

  const openFileDialog = useCallback(() => {
    inputRef.current?.click()
  }, [])

  const add = useCallback(
    (fileList: File[] | FileList) => {
      const incoming = [...fileList]
      const patterns =
        accept
          ?.split(",")
          .map((value) => value.trim())
          .filter(Boolean) ?? []
      const accepted =
        patterns.length === 0
          ? incoming
          : incoming.filter((file) =>
              patterns.some((pattern) => {
                if (pattern.endsWith("/*")) {
                  return file.type.startsWith(pattern.slice(0, -1))
                }
                return file.type === pattern
              })
            )
      if (incoming.length && accepted.length === 0) {
        onError?.({
          code: "accept",
          message: "No files match the accepted types.",
        })
        return
      }
      const sized = maxFileSize ? accepted.filter((file) => file.size <= maxFileSize) : accepted
      if (accepted.length > 0 && sized.length === 0) {
        onError?.({
          code: "max_file_size",
          message: "All files exceed the maximum size.",
        })
        return
      }

      setItems((prev) => {
        const capacity =
          typeof maxFiles === "number" ? Math.max(0, maxFiles - prev.length) : undefined
        const capped = typeof capacity === "number" ? sized.slice(0, capacity) : sized
        if (typeof capacity === "number" && sized.length > capacity) {
          onError?.({
            code: "max_files",
            message: "Too many files. Some were not added.",
          })
        }
        const next: (PromptInputFile & { id: string })[] = []
        for (const file of capped) {
          next.push({
            filename: file.name,
            id: nanoid(),
            mediaType: file.type,
            size: file.size,
            type: "file",
            url: URL.createObjectURL(file),
          })
        }
        return next.length > 0 ? [...prev, ...next] : prev
      })
    },
    [accept, maxFiles, maxFileSize, onError]
  )

  const remove = useCallback(
    (id: string) =>
      setItems((prev) => {
        const found = prev.find((file) => file.id === id)
        if (found?.url) {
          URL.revokeObjectURL(found.url)
        }
        return prev.filter((file) => file.id !== id)
      }),
    []
  )

  const clearAttachments = useCallback(
    () =>
      setItems((prev) => {
        for (const file of prev) {
          if (file.url) {
            URL.revokeObjectURL(file.url)
          }
        }
        return []
      }),
    []
  )

  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return
      setIsDraggingFiles(true)
      e.preventDefault()
    }
    const onDragEnter = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) {
        setIsDraggingFiles(true)
      }
    }
    const onDragLeave = (e: DragEvent) => {
      if (globalDrop ? e.relatedTarget === null : e.currentTarget === e.target) {
        setIsDraggingFiles(false)
      }
    }
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return
      e.preventDefault()
      setIsDraggingFiles(false)
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        add(e.dataTransfer.files)
      }
    }

    if (globalDrop) {
      document.addEventListener("dragenter", onDragEnter)
      document.addEventListener("dragover", onDragOver)
      document.addEventListener("dragleave", onDragLeave)
      document.addEventListener("drop", onDrop)
      return () => {
        document.removeEventListener("dragenter", onDragEnter)
        document.removeEventListener("dragover", onDragOver)
        document.removeEventListener("dragleave", onDragLeave)
        document.removeEventListener("drop", onDrop)
      }
    }

    const form = formRef.current
    if (!form) return
    form.addEventListener("dragenter", onDragEnter)
    form.addEventListener("dragover", onDragOver)
    form.addEventListener("dragleave", onDragLeave)
    form.addEventListener("drop", onDrop)
    return () => {
      form.removeEventListener("dragenter", onDragEnter)
      form.removeEventListener("dragover", onDragOver)
      form.removeEventListener("dragleave", onDragLeave)
      form.removeEventListener("drop", onDrop)
    }
  }, [add, globalDrop])

  useEffect(
    () => () => {
      for (const file of filesRef.current) {
        if (file.url) {
          URL.revokeObjectURL(file.url)
        }
      }
    },
    []
  )

  const handleChange: ChangeEventHandler<HTMLInputElement> = useCallback(
    (event) => {
      if (event.currentTarget.files) {
        add(event.currentTarget.files)
      }
      event.currentTarget.value = ""
    },
    [add]
  )

  const attachmentsCtx = useMemo<AttachmentsContext>(
    () => ({
      add,
      clear: clearAttachments,
      files: items,
      openFileDialog,
      remove,
    }),
    [items, add, remove, clearAttachments, openFileDialog]
  )
  const layoutCtx = useMemo<PromptInputLayoutContextValue>(
    () => ({
      isMultiline,
      setMultiline: setIsMultiline,
    }),
    [isMultiline]
  )

  const handleSubmit: FormEventHandler<HTMLFormElement> = useCallback(
    async (event) => {
      event.preventDefault()

      const form = event.currentTarget
      const textarea = form.elements.namedItem("message")
      const text = textarea instanceof HTMLTextAreaElement ? textarea.value : ""

      form.reset()
      if (textarea instanceof HTMLTextAreaElement) {
        textarea.style.removeProperty("height")
      }
      setIsMultiline(false)

      try {
        const convertedFiles: PromptInputFile[] = await Promise.all(
          items.map(async ({ id: _id, ...item }) => {
            if (item.url?.startsWith("blob:")) {
              const dataUrl = await convertBlobUrlToDataUrl(item.url)
              return {
                ...item,
                url: dataUrl ?? item.url,
              }
            }
            return item
          })
        )

        await onSubmit({ files: convertedFiles, text }, event)
        clearAttachments()
      } catch {
        // Keep attachments available so failed sends can be retried.
      }
    },
    [clearAttachments, items, onSubmit]
  )

  return (
    <LocalAttachmentsContext.Provider value={attachmentsCtx}>
      <PromptInputLayoutContext.Provider value={layoutCtx}>
        <input
          accept={accept}
          aria-label="Upload files"
          className="hidden"
          multiple={multiple}
          onChange={handleChange}
          ref={inputRef}
          title="Upload files"
          type="file"
        />
        <form className={cn("w-full", className)} onSubmit={handleSubmit} ref={formRef} {...props}>
          <InputGroup
            className={cn(
              "relative h-auto min-h-12 overflow-hidden rounded-full px-2 py-1 transition-[border-radius,padding] duration-200 ease-out has-[>[data-align=block-start]]:rounded-[1.5rem] has-[>[data-align=block-start]]:py-1.5 data-[multiline=true]:rounded-[1.75rem] data-[multiline=true]:py-4",
              isDraggingFiles && "border-primary ring-primary/20 ring-3"
            )}
            data-multiline={isMultiline}
          >
            {children}
            {isDraggingFiles ? (
              <div className="border-primary bg-background/90 text-primary pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[inherit] border-2 border-dashed text-sm font-medium backdrop-blur-sm">
                Drop files to attach
              </div>
            ) : null}
          </InputGroup>
        </form>
      </PromptInputLayoutContext.Provider>
    </LocalAttachmentsContext.Provider>
  )
}

type PromptInputBodyProps = HTMLAttributes<HTMLDivElement>

export const PromptInputBody = ({ className, ...props }: PromptInputBodyProps) => {
  const layout = useContext(PromptInputLayoutContext)

  return (
    <div
      className={cn(
        "group/prompt-body grid min-h-10 w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-1.5 data-[multiline=true]:items-end data-[multiline=true]:gap-y-4",
        className
      )}
      data-multiline={layout?.isMultiline ?? false}
      {...props}
    />
  )
}

type PromptInputTextareaProps = ComponentProps<typeof InputGroupTextarea>

export const PromptInputTextarea = ({
  ref,
  onChange,
  onBlur,
  onInput,
  onKeyDown,
  className,
  disabled,
  placeholder = "Start with an idea, task, or question...",
  ...props
}: PromptInputTextareaProps) => {
  const attachments = usePromptInputAttachments()
  const layout = useContext(PromptInputLayoutContext)
  const [isComposing, setIsComposing] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const wasDisabledRef = useRef(Boolean(disabled))

  const focusTextarea = useCallback(() => {
    window.requestAnimationFrame(() => {
      const element = textareaRef.current
      if (!element) return
      if (document.activeElement === element) return
      element.focus()
    })
  }, [])

  const resizeTextarea = useCallback(
    (element?: HTMLTextAreaElement | null) => {
      const node = element ?? textareaRef.current
      if (!node) return
      const style = window.getComputedStyle(node)
      const lineHeight = Number.parseFloat(style.lineHeight) || 24
      const paddingBlock =
        Number.parseFloat(style.paddingTop || "0") + Number.parseFloat(style.paddingBottom || "0")
      const singleLineHeight = Math.ceil(lineHeight + paddingBlock)

      if (node.value.length === 0) {
        // The textarea height is a DOM concern, so direct style writes are
        // intentional here instead of adding extra React state.
        // eslint-disable-next-line react-hooks/immutability
        node.style.height = `${singleLineHeight}px`
        layout?.setMultiline(false)
        return
      }

      node.style.height = `${singleLineHeight}px`
      const scrollHeight = node.scrollHeight
      node.style.height = `${Math.min(scrollHeight, 192)}px`

      if (layout?.isMultiline) return

      layout?.setMultiline(scrollHeight > singleLineHeight + 1)
    },
    [layout]
  )

  const setTextareaRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      textareaRef.current = node

      if (typeof ref === "function") {
        ref(node)
        return
      }

      if (ref) {
        ref.current = node
      }
    },
    [ref]
  )

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback(
    (e) => {
      onKeyDown?.(e)

      if (e.defaultPrevented) {
        return
      }

      if (e.key === "Enter") {
        if (isComposing || e.nativeEvent.isComposing) {
          return
        }
        if (e.shiftKey) {
          return
        }
        e.preventDefault()

        const { form } = e.currentTarget
        const submitButton = form?.querySelector<HTMLButtonElement>('button[type="submit"]')
        if (submitButton?.disabled) {
          return
        }

        form?.requestSubmit()
      }

      if (e.key === "Backspace" && e.currentTarget.value === "" && attachments.files.length > 0) {
        e.preventDefault()
        const lastAttachment = attachments.files.at(-1)
        if (lastAttachment) {
          attachments.remove(lastAttachment.id)
        }
      }
    },
    [onKeyDown, isComposing, attachments]
  )

  const handlePaste: ClipboardEventHandler<HTMLTextAreaElement> = useCallback(
    (event) => {
      const items = event.clipboardData?.items

      if (!items) {
        return
      }

      const files: File[] = []

      for (const item of items) {
        if (item.kind === "file") {
          const file = item.getAsFile()
          if (file) {
            files.push(file)
          }
        }
      }

      if (files.length > 0) {
        event.preventDefault()
        attachments.add(files)
      }
    },
    [attachments]
  )

  const handleInput = useCallback<NonNullable<PromptInputTextareaProps["onInput"]>>(
    (event) => {
      resizeTextarea(event.currentTarget)
      onInput?.(event)
    },
    [onInput, resizeTextarea]
  )

  useEffect(() => {
    resizeTextarea()
  }, [resizeTextarea])

  useEffect(() => {
    focusTextarea()
  }, [focusTextarea])

  useEffect(() => {
    if (disabled) {
      wasDisabledRef.current = true
      return
    }

    if (!wasDisabledRef.current) {
      return
    }

    // Re-enable happens after the agent finishes streaming, so wait until the
    // textarea is interactive again before restoring focus for the next turn.
    wasDisabledRef.current = false
    focusTextarea()
  }, [disabled, focusTextarea])

  return (
    <InputGroupTextarea
      autoFocus
      className={cn(
        "max-h-48 min-h-7 px-1 py-0.5 text-base leading-6 whitespace-pre-wrap transition-[height] duration-150 ease-out placeholder:font-normal md:text-[15px]",
        className
      )}
      name="message"
      onBlur={(event) => {
        onBlur?.(event)
        if (event.defaultPrevented) return
        if (isFocusableControl(event.relatedTarget)) return
        focusTextarea()
      }}
      onChange={onChange}
      onCompositionEnd={() => setIsComposing(false)}
      onCompositionStart={() => setIsComposing(true)}
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      placeholder={placeholder}
      ref={setTextareaRef}
      rows={1}
      disabled={disabled}
      {...props}
    />
  )
}

type PromptInputButtonTooltip =
  | string
  | {
      content: ReactNode
      shortcut?: string
      side?: ComponentProps<typeof TooltipContent>["side"]
    }

type PromptInputButtonProps = ComponentProps<typeof InputGroupButton> & {
  tooltip?: PromptInputButtonTooltip
}

export const PromptInputButton = ({
  variant = "ghost",
  className,
  size,
  tooltip,
  ...props
}: PromptInputButtonProps) => {
  const newSize = size ?? (Children.count(props.children) > 1 ? "sm" : "icon-sm")

  const button = (
    <InputGroupButton
      className={cn(
        "data-[variant=ghost]:hover:bg-foreground/6 dark:data-[variant=ghost]:hover:bg-foreground/10 data-[variant=ghost]:aria-expanded:bg-foreground/8 dark:data-[variant=ghost]:aria-expanded:bg-foreground/12 data-[variant=ghost]:data-[state=open]:bg-foreground/8 dark:data-[variant=ghost]:data-[state=open]:bg-foreground/12 rounded-full",
        className
      )}
      size={newSize}
      type="button"
      variant={variant}
      {...props}
    />
  )

  if (!tooltip) {
    return button
  }

  const tooltipContent = typeof tooltip === "string" ? tooltip : tooltip.content
  const shortcut = typeof tooltip === "string" ? undefined : tooltip.shortcut
  const side = typeof tooltip === "string" ? "top" : (tooltip.side ?? "top")

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side={side}>
        {tooltipContent}
        {shortcut && <span className="text-muted-foreground ml-2">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  )
}

type PromptInputSubmitProps = ComponentProps<typeof InputGroupButton> & {
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

  let Icon = <ArrowUpIcon />

  if (status === "submitted") {
    Icon = <Spinner />
  } else if (status === "streaming") {
    Icon = <SquareIcon />
  } else if (status === "error") {
    Icon = <XIcon />
  }

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (isGenerating && onStop) {
        e.preventDefault()
        onStop()
        return
      }
      onClick?.(e)
    },
    [isGenerating, onStop, onClick]
  )

  return (
    <InputGroupButton
      aria-label={isGenerating ? "Stop" : "Submit"}
      className={cn("rounded-full", className)}
      onClick={handleClick}
      size={size}
      type={isGenerating && onStop ? "button" : "submit"}
      variant={variant}
      {...props}
    >
      {children ?? Icon}
    </InputGroupButton>
  )
}
