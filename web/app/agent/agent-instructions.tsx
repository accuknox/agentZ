"use client"

import { useState, type RefCallback } from "react"
import { Textarea } from "@/components/ui/textarea"
import { EditorView } from "@codemirror/view"
import {
  MDXEditor,
  createRootEditorSubscription$,
  codeBlockPlugin,
  codeMirrorPlugin,
  headingsPlugin,
  linkPlugin,
  listsPlugin,
  insertMarkdown$,
  markdown$,
  markdownProcessingError$,
  markdownShortcutPlugin,
  quotePlugin,
  realmPlugin,
  thematicBreakPlugin,
  type MDXEditorMethods,
  type MDXEditorProps,
} from "@mdxeditor/editor"

const markdownPastePlugin = realmPlugin<{ onErrorAction: () => void }>({
  init(realm, params) {
    realm.sub(markdownProcessingError$, (error) => {
      if (!error) return
      // Paste errors are rolled back synchronously; initial parse errors need a source editor.
      queueMicrotask(() => {
        if (realm.getValue(markdownProcessingError$)) params?.onErrorAction()
      })
    })
    realm.pub(createRootEditorSubscription$, (editor) => {
      const onPaste = (event: ClipboardEvent) => {
        const root = editor.getRootElement()
        // Clipboard events can target a paragraph; nested code editors own their paste.
        if (!root || root.ownerDocument.activeElement !== root) return
        const clipboard = event.clipboardData
        if (!editor.isEditable() || !clipboard) return
        const markdown = clipboard.getData("text/markdown")
        if (!markdown && clipboard.getData("text/html")) return
        const text = markdown || clipboard.getData("text/plain")
        if (!text) return

        const state = editor.getEditorState()
        const previous = realm.getValue(markdown$)
        realm.pub(insertMarkdown$, text)
        if (realm.getValue(markdownProcessingError$)) {
          // Let the native paste keep unsupported syntax as text without losing the draft.
          editor.setEditorState(state)
          realm.pubIn({ [markdownProcessingError$]: null, [markdown$]: previous })
          return
        }
        event.preventDefault()
        event.stopPropagation()
      }
      const unsubscribe = editor.registerRootListener((root, previous) => {
        previous?.removeEventListener("paste", onPaste, true)
        root?.addEventListener("paste", onPaste, true)
      })
      return () => {
        editor.getRootElement()?.removeEventListener("paste", onPaste, true)
        unsubscribe()
      }
    })
  },
})

const codeTheme = EditorView.theme({
  "&": { backgroundColor: "var(--muted)", color: "var(--foreground)" },
  ".cm-content": { color: "var(--foreground)", caretColor: "var(--foreground)" },
  ".cm-scroller": { fontFamily: "var(--font-mono)" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  ".cm-gutters": { display: "none" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in oklab, var(--primary) 22%, transparent)",
  },
})

export default function AgentInstructions({
  markdown,
  defaultMarkdown,
  editorRef,
  onBlurAction,
  onChangeAction,
  readOnly,
}: Pick<MDXEditorProps, "markdown" | "readOnly"> & {
  defaultMarkdown: MDXEditorProps["markdown"]
  editorRef: RefCallback<MDXEditorMethods | HTMLTextAreaElement>
  onBlurAction: MDXEditorProps["onBlur"]
  onChangeAction: (markdown: string) => void
}) {
  const [source, setSource] = useState(false)

  return (
    <div className="agent-instructions border-b border-transparent transition-colors group-data-[invalid=true]/field:border-destructive focus-within:border-border">
      {source ? (
        <Textarea
          ref={editorRef}
          aria-label="Custom instructions"
          className="field-sizing-content max-h-70 min-h-18 resize-none rounded-none border-0 bg-transparent p-2 font-mono text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
          value={markdown}
          readOnly={readOnly}
          onChange={(event) => onChangeAction(event.target.value)}
          onBlur={(event) => onBlurAction?.(event.nativeEvent)}
        />
      ) : (
        <MDXEditor
          ref={editorRef}
          markdown={defaultMarkdown}
          trim={false}
          suppressHtmlProcessing
          readOnly={readOnly}
          placeholder={
            <span className="block space-y-3 text-muted-foreground">
              For example:
              <br />
              You help our product team turn customer interviews into research notes. Group
              recurring problems and cite the notes behind each finding. Separate evidence from
              assumptions. Use short headings and bullet points. Ask when a detail is unclear. Leave
              out personal information and never fill gaps with invented facts.
            </span>
          }
          contentEditableClassName="agent-instructions-content"
          onBlur={onBlurAction}
          onChange={(value, initial) => {
            // Opening a prompt must not replace it with the editor's serialization.
            if (!initial) onChangeAction(value)
          }}
          translation={(key, fallback) =>
            key === "contentArea.editableMarkdown" ? "Custom instructions" : fallback
          }
          plugins={[
            headingsPlugin(),
            listsPlugin(),
            quotePlugin(),
            linkPlugin(),
            thematicBreakPlugin(),
            codeBlockPlugin({ defaultCodeBlockLanguage: "txt" }),
            codeMirrorPlugin({
              codeMirrorExtensions: [codeTheme],
              codeBlockLanguages: { "": "Plain text", txt: "Plain text" },
              autoLoadLanguageSupport: false,
            }),
            markdownPastePlugin({
              onErrorAction: () => setSource(true),
            }),
            markdownShortcutPlugin(),
          ]}
        />
      )}
    </div>
  )
}
