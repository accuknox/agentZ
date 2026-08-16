"use client"

import * as React from "react"
import { Avatar as AvatarPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

function Avatar({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Root> & {
  size?: "default" | "sm" | "lg"
}) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      data-size={size}
      className={cn(
        "group/avatar after:border-border relative flex size-8 shrink-0 rounded-full select-none after:absolute after:inset-0 after:rounded-full after:border after:mix-blend-darken data-[size=lg]:size-10 data-[size=sm]:size-6 dark:after:mix-blend-lighten",
        className
      )}
      {...props}
    />
  )
}

function AvatarImage({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn("aspect-square size-full rounded-full object-cover", className)}
      {...props}
    />
  )
}

function AvatarFallback({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        "bg-muted text-muted-foreground flex size-full items-center justify-center rounded-full text-sm group-data-[size=sm]/avatar:text-xs",
        className
      )}
      {...props}
    />
  )
}

function AvatarBadge({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="avatar-badge"
      className={cn(
        "bg-primary text-primary-foreground ring-background absolute right-0 bottom-0 z-10 inline-flex items-center justify-center rounded-full bg-blend-color ring-2 select-none",
        "group-data-[size=sm]/avatar:size-2 group-data-[size=sm]/avatar:[&>svg]:hidden",
        "group-data-[size=default]/avatar:size-2.5 group-data-[size=default]/avatar:[&>svg]:size-2",
        "group-data-[size=lg]/avatar:size-3 group-data-[size=lg]/avatar:[&>svg]:size-2",
        className
      )}
      {...props}
    />
  )
}

function AvatarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-group"
      className={cn(
        "group/avatar-group *:data-[slot=avatar]:ring-background flex -space-x-2 *:data-[slot=avatar]:ring-2",
        className
      )}
      {...props}
    />
  )
}

function AvatarGroupCount({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-group-count"
      className={cn(
        "bg-muted text-muted-foreground ring-background relative flex size-8 shrink-0 items-center justify-center rounded-full text-sm ring-2 group-has-data-[size=lg]/avatar-group:size-10 group-has-data-[size=sm]/avatar-group:size-6 [&>svg]:size-4 group-has-data-[size=lg]/avatar-group:[&>svg]:size-5 group-has-data-[size=sm]/avatar-group:[&>svg]:size-3",
        className
      )}
      {...props}
    />
  )
}

function initialsFromLabel(label: string) {
  return label
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("")
}

/** UserIdentity presents a person's avatar, name, and email as one unit. */
function UserIdentity({
  className,
  email,
  image,
  name,
  secondary = true,
  size = "sm",
}: {
  className?: string
  email?: string | null
  image?: string | null
  name?: string | null
  secondary?: boolean
  size?: "default" | "sm"
}) {
  const label = name || email || "Unknown user"

  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      <Avatar size={size}>
        <AvatarImage alt={label} src={image ?? undefined} />
        <AvatarFallback>{initialsFromLabel(label)}</AvatarFallback>
      </Avatar>
      <span className="min-w-0 leading-tight">
        <span className="block truncate font-medium" title={label}>
          {label}
        </span>
        {secondary && name && email ? (
          <span className="text-muted-foreground block truncate text-xs" title={email}>
            {email}
          </span>
        ) : null}
      </span>
    </span>
  )
}

/** UserAvatar renders only a person's avatar; hovering reveals their name and email. */
function UserAvatar({
  email,
  id,
  image,
  name,
  size = "sm",
}: {
  email?: string | null
  id?: string
  image?: string | null
  name?: string | null
  size?: "default" | "sm"
}) {
  const label = name || email || id || "Unknown user"

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Avatar size={size}>
          <AvatarImage alt={label} src={image ?? undefined} />
          <AvatarFallback>{initialsFromLabel(label)}</AvatarFallback>
        </Avatar>
      </TooltipTrigger>
      <TooltipContent sideOffset={4}>
        <span className="max-w-64 truncate">
          {label}
          {email && email !== label ? <span className="text-background/60"> · {email}</span> : null}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}

export {
  Avatar,
  AvatarImage,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarBadge,
  UserAvatar,
  UserIdentity,
}
