import { Suspense } from "react"
import { OAuthResult } from "./result"

type OAuthResultPageProps = {
  searchParams: Promise<{ status?: string; flowId?: string; message?: string; warning?: string }>
}

export const metadata = { title: "Connection result" }

export default function OAuthResultPage(props: OAuthResultPageProps) {
  return (
    <main className="flex min-h-svh w-full items-center justify-center p-6">
      <Suspense>
        <OAuthResultContent {...props} />
      </Suspense>
    </main>
  )
}

async function OAuthResultContent({ searchParams }: OAuthResultPageProps) {
  const { status, flowId, message, warning } = await searchParams
  return (
    <OAuthResult
      status={status === "success" ? "success" : "error"}
      flowId={flowId}
      message={message ?? ""}
      warning={warning}
    />
  )
}
