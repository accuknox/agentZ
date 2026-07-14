"use client"

import * as React from "react"
import { indentWithTab } from "@codemirror/commands"
import { Compartment, EditorState } from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"
import { LanguageDescription, syntaxHighlighting } from "@codemirror/language"
import { languages } from "@codemirror/language-data"
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark"
import { minimalSetup } from "codemirror"
import { useTheme } from "next-themes"

type CodeEditorProps = {
  filename: string
  onChange: (value: string) => void
  onSave: () => void
  readOnly?: boolean
  value: string
}

export function CodeEditor({ filename, onChange, onSave, readOnly, value }: CodeEditorProps) {
  const { resolvedTheme } = useTheme()
  const hostRef = React.useRef<HTMLDivElement>(null)
  const viewRef = React.useRef<EditorView>(null)
  const initialValueRef = React.useRef(value)
  const onChangeRef = React.useRef(onChange)
  const onSaveRef = React.useRef(onSave)
  const applyingValueRef = React.useRef(false)

  React.useEffect(() => {
    onChangeRef.current = onChange
    onSaveRef.current = onSave
  })

  React.useEffect(() => {
    const host = hostRef.current
    if (!host) {
      return
    }

    const language = new Compartment()
    const dark = resolvedTheme === "dark"
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialValueRef.current,
        extensions: [
          minimalSetup,
          EditorState.readOnly.of(readOnly ?? false),
          EditorView.editable.of(readOnly !== true),
          language.of([]),
          keymap.of([
            indentWithTab,
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                onSaveRef.current()
                return true
              },
            },
          ]),
          EditorView.lineWrapping,
          ...(dark ? [syntaxHighlighting(oneDarkHighlightStyle)] : []),
          EditorView.theme(
            {
              "&": {
                backgroundColor: "var(--background)",
                color: "var(--foreground)",
                height: "100%",
              },
              ".cm-content": {
                caretColor: "var(--foreground)",
                fontFamily: "var(--font-mono)",
                fontSize: "14px",
                lineHeight: "1.5",
                padding: "12px 0 80px",
              },
              ".cm-cursor, .cm-dropCursor": {
                borderLeftColor: "var(--foreground)",
              },
              ".cm-activeLine": {
                backgroundColor: "color-mix(in oklab, var(--muted) 55%, transparent)",
              },
              ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
                backgroundColor: "color-mix(in oklab, var(--primary) 22%, transparent)",
              },
              ".cm-panels": {
                backgroundColor: "var(--popover)",
                color: "var(--popover-foreground)",
              },
              ".cm-panels.cm-panels-top": {
                borderBottom: "1px solid var(--border)",
              },
              ".cm-search input": {
                backgroundColor: "var(--background)",
                border: "1px solid var(--border)",
                borderRadius: "6px",
                color: "var(--foreground)",
                outline: "none",
              },
              ".cm-scroller": {
                fontFamily: "var(--font-mono)",
                overflow: "auto",
              },
            },
            { dark }
          ),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !applyingValueRef.current) {
              onChangeRef.current(update.state.doc.toString())
            }
          }),
        ],
      }),
    })
    viewRef.current = view

    let active = true
    const description = LanguageDescription.matchFilename(languages, filename)
    if (description) {
      void description
        .load()
        .then((support) => {
          if (active) view.dispatch({ effects: language.reconfigure(support) })
        })
        .catch(() => undefined)
    }

    return () => {
      active = false
      view.destroy()
      viewRef.current = null
    }
  }, [filename, readOnly, resolvedTheme])

  React.useEffect(() => {
    const view = viewRef.current
    if (!view || view.state.doc.toString() === value) {
      return
    }

    applyingValueRef.current = true
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    })
    applyingValueRef.current = false
  }, [value])

  return <div className="h-full min-h-0 overflow-hidden" ref={hostRef} />
}
