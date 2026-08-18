"use client"

import type { Route } from "next"
import Image from "next/image"
import { useRouter } from "next/navigation"
import { createContext, useContext, useTransition } from "react"

type ScopeTransition = {
  isPending: boolean
  navigate(destination: Route | Promise<Route>): void
}

const ScopeTransitionContext = createContext<ScopeTransition | null>(null)

export function AgentZTransition() {
  return (
    <div
      aria-label="Loading AgentZ"
      className="bg-background fixed inset-0 z-[100] flex items-center justify-center"
      data-agentz-transition=""
      role="status"
    >
      <Image alt="AgentZ" height={84} priority src="/agentz-logo.svg" width={96} />
    </div>
  )
}

export function ScopeTransitionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  function navigate(destination: Route | Promise<Route>) {
    startTransition(async () => {
      router.push(await destination)
    })
  }

  return (
    <ScopeTransitionContext value={{ isPending, navigate }}>
      {children}
      {isPending ? <AgentZTransition /> : null}
    </ScopeTransitionContext>
  )
}

export function useScopeTransition(): ScopeTransition {
  const transition = useContext(ScopeTransitionContext)
  if (!transition) {
    throw new Error("useScopeTransition must be used within ScopeTransitionProvider")
  }
  return transition
}
