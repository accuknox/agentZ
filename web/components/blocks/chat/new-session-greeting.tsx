type NewSessionGreetingProps = {
  firstName?: string
  greetingIndex?: number
}

const greetingTemplates = [
  "Welcome back, {name}.",
  "What can I help you with today, {name}?",
  "Ready when you are, {name}.",
  "Hi {name}, what are we working on?",
  "Good to see you, {name}.",
  "Let's get started, {name}.",
  "What's on your mind, {name}?",
  "{name}, how can I help?",
  "Need a hand with something, {name}?",
  "{name}, what would you like to explore today?",
] as const

/**
 * NewSessionGreeting keeps the new-chat state focused on the prompt instead of
 * creating a separate empty-state card.
 */
export function NewSessionGreeting({ firstName, greetingIndex = 0 }: NewSessionGreetingProps) {
  if (!firstName) {
    return (
      <div className="pointer-events-none flex justify-center px-4 text-center">
        <h1 className="text-foreground text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
          How can I help?
        </h1>
      </div>
    )
  }

  const index = greetingIndex % greetingTemplates.length
  const greeting = greetingTemplates[index].replace("{name}", firstName)

  return (
    <div className="pointer-events-none flex justify-center px-4 text-center">
      <h1 className="text-foreground text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
        {greeting}
      </h1>
    </div>
  )
}
