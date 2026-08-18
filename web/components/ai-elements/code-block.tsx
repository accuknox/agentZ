"use client"

import { cn } from "@/lib/utils"
import type { CSSProperties, HTMLAttributes } from "react"
import { createContext, memo, useEffect, useMemo, useState } from "react"
import type { BundledLanguage, BundledTheme, HighlighterGeneric, ThemedToken } from "shiki"
import { createHighlighter } from "shiki"

// Shiki uses bitflags for font styles: 1=italic, 2=bold, 4=underline
// oxlint-disable-next-line eslint(no-bitwise)
const isItalic = (fontStyle: number | undefined) => fontStyle && fontStyle & 1
// oxlint-disable-next-line eslint(no-bitwise)
const isBold = (fontStyle: number | undefined) => fontStyle && fontStyle & 2
const isUnderline = (fontStyle: number | undefined) =>
  // oxlint-disable-next-line eslint(no-bitwise)
  fontStyle && fontStyle & 4

// Transform tokens to include pre-computed keys to avoid noArrayIndexKey lint
interface KeyedToken {
  token: ThemedToken
  key: string
}
interface KeyedLine {
  tokens: KeyedToken[]
  key: string
}

const addKeysToTokens = (lines: ThemedToken[][]): KeyedLine[] =>
  lines.map((line, lineIdx) => ({
    key: `line-${lineIdx}`,
    tokens: line.map((token, tokenIdx) => ({
      key: `line-${lineIdx}-${tokenIdx}`,
      token,
    })),
  }))

// Token rendering component
const TokenSpan = ({ token }: { token: ThemedToken }) => {
  const style: CSSProperties = {
    backgroundColor: token.bgColor,
    color: token.color,
    fontStyle: isItalic(token.fontStyle) ? "italic" : undefined,
    fontWeight: isBold(token.fontStyle) ? "bold" : undefined,
    textDecoration: isUnderline(token.fontStyle) ? "underline" : undefined,
    ...token.htmlStyle,
  }

  return (
    <span className="dark:bg-(--shiki-dark-bg)! dark:text-(--shiki-dark)!" style={style}>
      {token.content}
    </span>
  )
}

// Line number styles using CSS counters
const LINE_NUMBER_CLASSES = cn(
  "block",
  "before:content-[counter(line)]",
  "before:inline-block",
  "before:[counter-increment:line]",
  "before:w-8",
  "before:mr-4",
  "before:text-right",
  "before:text-muted-foreground/50",
  "before:font-mono",
  "before:select-none"
)

// Line rendering component
const LineSpan = ({
  keyedLine,
  showLineNumbers,
}: {
  keyedLine: KeyedLine
  showLineNumbers: boolean
}) => (
  <span className={showLineNumbers ? LINE_NUMBER_CLASSES : "block"}>
    {keyedLine.tokens.length === 0
      ? "\n"
      : keyedLine.tokens.map(({ token, key }) => <TokenSpan key={key} token={token} />)}
  </span>
)

// Types
type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string
  language: BundledLanguage
  showLineNumbers?: boolean
}

interface TokenizedCode {
  tokens: ThemedToken[][]
  fg: string
  bg: string
}

interface CodeBlockContextType {
  code: string
}

// Context
const CodeBlockContext = createContext<CodeBlockContextType>({
  code: "",
})

// Highlighter cache (singleton per language)
const highlighterCache = new Map<
  string,
  Promise<HighlighterGeneric<BundledLanguage, BundledTheme>>
>()

// Token cache
const tokensCache = new Map<string, TokenizedCode>()

// Subscribers for async token updates
const subscribers = new Map<string, Set<(result: TokenizedCode) => void>>()

const getTokensCacheKey = (code: string, language: BundledLanguage) => {
  const start = code.slice(0, 100)
  const end = code.length > 100 ? code.slice(-100) : ""
  return `${language}:${code.length}:${start}:${end}`
}

const getHighlighter = (
  language: BundledLanguage
): Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> => {
  const cached = highlighterCache.get(language)
  if (cached) {
    return cached
  }

  const highlighterPromise = createHighlighter({
    langs: [language],
    themes: ["github-light", "github-dark"],
  })

  highlighterCache.set(language, highlighterPromise)
  return highlighterPromise
}

// Create raw tokens for immediate display while highlighting loads
const createRawTokens = (code: string): TokenizedCode => {
  let offset = 0
  const tokens = code.split("\n").map((line) => {
    const lineOffset = offset
    offset += line.length + 1
    return line === ""
      ? []
      : [
          {
            color: "inherit",
            content: line,
            offset: lineOffset,
          },
        ]
  })

  return {
    bg: "transparent",
    fg: "inherit",
    tokens,
  }
}

// Synchronous highlight with callback for async results
const highlightCode = (
  code: string,
  language: BundledLanguage,
  // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-callbacks)
  callback?: (result: TokenizedCode) => void
): TokenizedCode | null => {
  const tokensCacheKey = getTokensCacheKey(code, language)

  // Return cached result if available
  const cached = tokensCache.get(tokensCacheKey)
  if (cached) {
    return cached
  }

  // Subscribe callback if provided
  if (callback) {
    if (!subscribers.has(tokensCacheKey)) {
      subscribers.set(tokensCacheKey, new Set())
    }
    subscribers.get(tokensCacheKey)?.add(callback)
  }

  // Start highlighting in background - fire-and-forget async pattern
  getHighlighter(language)
    // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then)
    .then((highlighter) => {
      const availableLangs = highlighter.getLoadedLanguages()
      const langToUse = availableLangs.includes(language) ? language : "text"

      const result = highlighter.codeToTokens(code, {
        lang: langToUse,
        themes: {
          dark: "github-dark",
          light: "github-light",
        },
      })

      const tokenized: TokenizedCode = {
        bg: result.bg ?? "transparent",
        fg: result.fg ?? "inherit",
        tokens: result.tokens,
      }

      // Cache the result
      tokensCache.set(tokensCacheKey, tokenized)

      // Notify all subscribers
      const subs = subscribers.get(tokensCacheKey)
      if (subs) {
        for (const sub of subs) {
          sub(tokenized)
        }
        subscribers.delete(tokensCacheKey)
      }
    })
    // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then), eslint-plugin-promise(prefer-await-to-callbacks)
    .catch((error) => {
      console.error("Failed to highlight code:", error)
      subscribers.delete(tokensCacheKey)
    })

  return null
}

const CodeBlockBody = memo(
  ({
    tokenized,
    showLineNumbers,
    className,
  }: {
    tokenized: TokenizedCode
    showLineNumbers: boolean
    className?: string
  }) => {
    const preStyle = useMemo(
      () => ({
        backgroundColor: tokenized.bg,
        color: tokenized.fg,
      }),
      [tokenized.bg, tokenized.fg]
    )

    const keyedLines = useMemo(() => addKeysToTokens(tokenized.tokens), [tokenized.tokens])

    return (
      <pre
        className={cn(
          "m-0 p-4 text-sm dark:bg-(--shiki-dark-bg)! dark:text-(--shiki-dark)!",
          className
        )}
        style={preStyle}
      >
        <code
          className={cn(
            "font-mono text-sm",
            showLineNumbers && "[counter-increment:line_0] [counter-reset:line]"
          )}
        >
          {keyedLines.map((keyedLine) => (
            <LineSpan key={keyedLine.key} keyedLine={keyedLine} showLineNumbers={showLineNumbers} />
          ))}
        </code>
      </pre>
    )
  },
  (prevProps, nextProps) =>
    prevProps.tokenized === nextProps.tokenized &&
    prevProps.showLineNumbers === nextProps.showLineNumbers &&
    prevProps.className === nextProps.className
)

CodeBlockBody.displayName = "CodeBlockBody"

const CodeBlockContainer = ({
  className,
  language,
  style,
  ...props
}: HTMLAttributes<HTMLDivElement> & { language: string }) => (
  <div
    className={cn(
      "group bg-background text-foreground relative w-full overflow-hidden rounded-md border",
      className
    )}
    data-language={language}
    style={{
      containIntrinsicSize: "auto 200px",
      contentVisibility: "auto",
      ...style,
    }}
    {...props}
  />
)

export const CodeBlockContent = ({
  code,
  language,
  showLineNumbers = false,
}: {
  code: string
  language: BundledLanguage
  showLineNumbers?: boolean
}) => {
  // Memoized raw tokens for immediate display
  const rawTokens = useMemo(() => createRawTokens(code), [code])

  // Synchronous cache lookup - avoids setState in effect for cached results
  const syncTokens = useMemo(
    () => highlightCode(code, language) ?? rawTokens,
    [code, language, rawTokens]
  )

  // Async highlighting result (populated after shiki loads)
  const [asyncTokens, setAsyncTokens] = useState<{
    code: string
    language: BundledLanguage
    tokens: TokenizedCode
  } | null>(null)

  useEffect(() => {
    let cancelled = false

    const cachedResult = highlightCode(code, language, (result) => {
      if (!cancelled) {
        setAsyncTokens({ code, language, tokens: result })
      }
    })
    if (cachedResult && !cancelled) {
      queueMicrotask(() => {
        if (!cancelled) {
          setAsyncTokens({ code, language, tokens: cachedResult })
        }
      })
    }

    return () => {
      cancelled = true
    }
  }, [code, language])

  const tokenized =
    asyncTokens?.code === code && asyncTokens.language === language
      ? asyncTokens.tokens
      : syncTokens

  return (
    <div className="relative max-w-full overflow-auto">
      <CodeBlockBody showLineNumbers={showLineNumbers} tokenized={tokenized} />
    </div>
  )
}

export const CodeBlock = ({
  code,
  language,
  showLineNumbers = false,
  className,
  children,
  ...props
}: CodeBlockProps) => {
  const contextValue = useMemo(() => ({ code }), [code])

  return (
    <CodeBlockContext.Provider value={contextValue}>
      <CodeBlockContainer className={className} language={language} {...props}>
        {children}
        <CodeBlockContent code={code} language={language} showLineNumbers={showLineNumbers} />
      </CodeBlockContainer>
    </CodeBlockContext.Provider>
  )
}
