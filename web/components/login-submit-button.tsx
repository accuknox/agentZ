"use client"

import { useFormStatus } from "react-dom"
import { GitHubDark } from "@ridemountainpig/svgl-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

export function LoginSubmitButton() {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" variant="outline" disabled={pending}>
      {pending ? <Spinner data-icon="inline-start" /> : <GitHubDark data-icon="inline-start" />}
      Continue with GitHub
    </Button>
  )
}
