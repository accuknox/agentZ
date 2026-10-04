import Image from "next/image"
import Link from "next/link"
import { Suspense, type ReactNode } from "react"
import { GitHubDark, GitHubLight } from "@ridemountainpig/svgl-react"
import { Star } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

import { AuthCarousel } from "./auth-carousel"

export function AuthPage({ children }: { children: ReactNode }) {
  return (
    <main
      id="main-content"
      className="grid min-h-svh w-full lg:h-svh lg:min-h-0 lg:grid-cols-[2fr_3fr] lg:overflow-hidden"
    >
      <div className="flex min-h-0 flex-col gap-8 px-6 py-6 sm:px-10 lg:overflow-y-auto lg:px-12">
        <Link
          href="/"
          prefetch={false}
          aria-label="AgentZ home"
          className="flex w-fit items-center gap-2.5"
        >
          <Image src="/agentz-logo.svg" alt="" width={35} height={30} />
          <span className="text-2xl font-semibold tracking-tight">AgentZ</span>
        </Link>
        <div className="flex flex-1 items-center justify-center pb-6">
          <div className="w-full max-w-[360px]">
            <Suspense
              fallback={
                <div
                  role="status"
                  aria-label="Loading sign-in options"
                  className="flex flex-col gap-6"
                >
                  <Skeleton className="h-9 w-3/4" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <span className="sr-only">Loading sign-in options…</span>
                </div>
              }
            >
              {children}
            </Suspense>
          </div>
        </div>
      </div>
      <aside
        className="relative hidden min-h-0 min-w-0 items-center justify-center overflow-hidden bg-primary/5 lg:flex"
        aria-label="Explore AgentZ"
      >
        <div className="w-full max-w-xl scale-[min(1,var(--carousel-scale))] px-6 py-6 [--carousel-scale:1.75] xl:scale-[min(1.25,var(--carousel-scale))] xl:px-8 min-[87.5rem]:scale-[min(1.5625,var(--carousel-scale))] min-[112.5rem]:scale-[min(1.75,var(--carousel-scale))] [@media(1000px<height<=1120px)]:[--carousel-scale:1.6] [@media(420px<height<=560px)]:[--carousel-scale:0.65] [@media(560px<height<=620px)]:[--carousel-scale:0.9] [@media(620px<height<=700px)]:[--carousel-scale:1] [@media(700px<height<=760px)]:[--carousel-scale:1.1] [@media(760px<height<=860px)]:[--carousel-scale:1.2] [@media(860px<height<=1000px)]:[--carousel-scale:1.35] [@media(height<=420px)]:[--carousel-scale:0.5]">
          <AuthCarousel />
        </div>
        <Button
          asChild
          variant="outline"
          size="sm"
          className="absolute right-6 bottom-6 rounded-full"
        >
          <a href="https://github.com/accuknox/agentZ/" target="_blank" rel="noopener noreferrer">
            <GitHubLight aria-hidden="true" data-icon="inline-start" className="dark:hidden" />
            <GitHubDark aria-hidden="true" data-icon="inline-start" className="hidden dark:block" />
            Star on GitHub
            <Star
              aria-hidden="true"
              data-icon="inline-end"
              className="fill-warning/15 text-warning"
            />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </Button>
      </aside>
    </main>
  )
}
