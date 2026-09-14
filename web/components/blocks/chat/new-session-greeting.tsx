type NewSessionGreetingProps = {
  projectName?: string
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
export function NewSessionGreeting({
  projectName,
  firstName,
  greetingIndex = 0,
}: NewSessionGreetingProps) {
  const greetings = projectName
    ? ([
        "What's next for",
        "Where should we start with",
        "What would you like to change in",
        "Have something in mind for",
        "What needs attention in",
      ] as const)
    : greetingTemplates
  const index = ((greetingIndex % greetings.length) + greetings.length) % greetings.length
  const template = greetings[index] ?? greetings[0]
  const greeting = projectName ? (
    <>
      {template}{" "}
      <span className="decoration-foreground/60 underline decoration-dotted decoration-1 underline-offset-4">
        {projectName}
      </span>
      ?
    </>
  ) : firstName ? (
    template.replace("{name}", () => firstName)
  ) : (
    "How can I help?"
  )

  return (
    <div className="pointer-events-none flex justify-center px-4 text-center">
      <h1 className="text-foreground min-w-0 text-2xl font-semibold tracking-tight text-balance wrap-anywhere @xl/chat:text-3xl">
        {greeting}
      </h1>
    </div>
  )
}
