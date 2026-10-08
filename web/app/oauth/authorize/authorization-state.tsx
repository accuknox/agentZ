import Image from "next/image"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"

export function AuthorizationState({
  title,
  description,
  pending = false,
}: {
  title: string
  description: string
  pending?: boolean
}) {
  return (
    <Empty
      className="min-h-80 gap-5 rounded-none border-0 py-10"
      role={pending ? "status" : "alert"}
    >
      <EmptyHeader className="gap-3">
        <EmptyMedia className="mb-1">
          <Image
            src="/agentz-logo.svg"
            alt="AgentZ"
            width={46}
            height={40}
            className="h-10 w-auto"
          />
        </EmptyMedia>
        <EmptyTitle className="text-base font-semibold">
          <h1>{title}</h1>
        </EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row justify-center">
        {pending ? (
          <Spinner />
        ) : (
          <Button asChild>
            <Link href="/">Go to AgentZ</Link>
          </Button>
        )}
      </EmptyContent>
    </Empty>
  )
}
