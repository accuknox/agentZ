"use client"

import { GitHubDark, GitHubLight } from "@ridemountainpig/svgl-react"
import { ArrowUpRight, MessageCircle, Star, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { useSidebar } from "@/components/ui/sidebar"

export function SidebarLinks({ showEnterpriseUpgrade }: { showEnterpriseUpgrade: boolean }) {
  const { isMobile, state } = useSidebar()

  if (!isMobile && state === "collapsed") {
    return null
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="secondary"
          size="icon"
          className="rounded-md"
          aria-label="AgentZ links"
          title={showEnterpriseUpgrade ? "GitHub and Enterprise" : "Star on GitHub"}
        >
          <Zap aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        aria-label="AgentZ links"
        side={isMobile ? "bottom" : "right"}
        align={isMobile ? "end" : "start"}
        sideOffset={8}
        collisionPadding={16}
        className="w-64 max-w-[calc(100vw-2rem)] gap-0 rounded-md border-2 border-dashed border-muted-foreground/50 bg-sidebar-control-surface p-0 shadow-sm ring-0"
      >
        <div className="flex flex-col gap-2 p-3.5">
          <h2 className="font-medium">Star on GitHub</h2>
          <Button asChild variant="outline" size="sm">
            <a href="https://github.com/accuknox/agentZ/" target="_blank" rel="noopener noreferrer">
              <GitHubLight aria-hidden="true" data-icon="inline-start" className="dark:hidden" />
              <GitHubDark
                aria-hidden="true"
                data-icon="inline-start"
                className="hidden dark:block"
              />
              GitHub
              <Star aria-hidden="true" data-icon="inline-end" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </Button>
        </div>
        {showEnterpriseUpgrade ? (
          <>
            <Separator className="border-t-2 border-dashed border-muted-foreground/50 bg-transparent data-horizontal:h-0" />
            <div className="flex flex-col gap-2 p-3.5">
              <h2 className="font-medium">Upgrade to enterprise</h2>
              <Button asChild variant="outline" size="sm">
                <a
                  href="https://app.cal.com/accuknoxinc/30min?overlayCalendar=true&notes=I%20am%20interested%20in%20a%20demo%20of%20the%20AgentZ%20Enterprise%20tier.&utm_source=website&utm_medium=cta&utm_campaign=agentz-enterprise-demo"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <MessageCircle aria-hidden="true" data-icon="inline-start" />
                  Reach out to us
                  <ArrowUpRight aria-hidden="true" data-icon="inline-end" />
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </Button>
            </div>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
