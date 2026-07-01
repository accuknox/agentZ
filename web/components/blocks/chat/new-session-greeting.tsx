"use client"

import Image from "next/image"
import { useEffect, useState } from "react"

type NewSessionGreetingProps = {
  firstName?: string
}

/**
 * NewSessionGreeting gives a new conversation a branded focal point without
 * competing with the composer once the first turn begins.
 */
export function NewSessionGreeting({ firstName }: NewSessionGreetingProps) {
  const name = firstName || "there"
  const [visibleName, setVisibleName] = useState("")

  useEffect(() => {
    let index = 0
    const timer = window.setInterval(() => {
      index += 1
      setVisibleName(name.slice(0, index))

      if (index >= name.length) {
        window.clearInterval(timer)
      }
    }, 90)

    return () => window.clearInterval(timer)
  }, [name])

  return (
    <div className="pointer-events-none flex min-h-full items-center justify-center px-4 py-10">
      <div className="flex max-w-xl flex-col items-center text-center">
        <Image
          alt=""
          aria-hidden="true"
          className="size-16"
          height={64}
          priority
          src="/emblem.svg"
          width={64}
        />
        <div className="mt-6 space-y-2">
          <p className="text-muted-foreground text-base">
            Hi, <span className="text-foreground">{visibleName}</span>
          </p>
          <h1 className="text-foreground text-3xl font-medium text-balance sm:text-4xl">
            What can I help you with today?
          </h1>
        </div>
      </div>
    </div>
  )
}
