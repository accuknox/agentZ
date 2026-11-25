"use client"

import { useState } from "react"
import Image from "next/image"
import { OtpInput } from "@/components/interior/otp-input"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"

// Matches better-auth's default device userCodeLength.
const codeLength = 8

/** DeviceCodeForm collects the user code an app displayed during device authorization. */
export function DeviceCodeForm() {
  const [code, setCode] = useState("")
  return (
    <form
      action="/oauth/authorize"
      className="mx-auto flex w-full max-w-sm flex-col items-center gap-8 text-center"
    >
      <Image src="/agentz-logo.svg" alt="AgentZ" width={46} height={40} className="h-10 w-auto" />
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Device activation</h1>
        <p className="text-sm text-muted-foreground">Enter the code displayed on your device.</p>
      </div>
      <Field>
        <FieldLabel htmlFor="device-user-code" className="sr-only">
          Device code
        </FieldLabel>
        <OtpInput
          id="device-user-code"
          name="user_code"
          required
          autoFocus
          alphanumeric
          length={codeLength}
          value={code}
          onChange={(event) => {
            setCode(event.currentTarget.value)
            // Submit once complete so pasting the code is the only step.
            if (event.currentTarget.value.length === codeLength)
              event.currentTarget.form?.requestSubmit()
          }}
        />
      </Field>
      <Button type="submit" className="w-full" disabled={code.length < codeLength}>
        Continue
      </Button>
    </form>
  )
}
