import { readFile, realpath, stat } from "node:fs/promises"
import { basename, extname, relative, sep } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { extractPdf } from "clawpdf"
import { parseOffice } from "officeparser"
import { read as readWorkbook, utils as spreadsheet } from "xlsx"

const maxFileBytes = 8 * 1024 * 1024
const maxOutputChars = 50 * 1024
const root = process.env.AGENTZ_HOME ?? "/home/agentz"
const visualModel = process.env.AGENTZ_ATTACHMENT_MODEL

const imageMediaTypes = new Map([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
])

function extractedText(text: string, offset: number) {
  const lines = text.split("\n")
  const start = offset - 1
  const output = lines.slice(start).join("\n").slice(0, maxOutputChars)
  const shown = output.split("\n").length
  const next = start + shown < lines.length ? start + shown + 1 : undefined
  return next ? `${output}\n\n[Output capped at 50 KiB. Continue with offset=${next}.]` : output
}

export default (async (plugin) => ({
  tool: {
    analyze_file: tool({
      description:
        "Extract content from DOCX, PPTX, XLSX, XLS, and PDF files, or visually inspect raster images and scanned PDFs. Use read or bash for ordinary text files.",
      args: {
        path: tool.schema.string().describe("Absolute file path under the agent home directory"),
        question: tool.schema.string().min(1).describe("What to understand from the file"),
        offset: tool.schema.int().min(1).optional().describe("One-based text line to start from"),
        pages: tool.schema
          .array(tool.schema.int().min(1))
          .max(20)
          .optional()
          .describe("One-based PDF pages to inspect, up to 20"),
      },
      async execute(args, context) {
        const [home, path] = await Promise.all([realpath(root), realpath(args.path)])
        const withinHome = relative(home, path)
        if (withinHome === "" || withinHome === ".." || withinHome.startsWith(`..${sep}`)) {
          throw new Error("file must be below the agent home directory")
        }

        const info = await stat(path)
        if (!info.isFile()) {
          throw new Error("path is not a regular file")
        }
        if (info.size > maxFileBytes) {
          throw new Error("file exceeds the 8 MiB analysis limit")
        }

        const extension = extname(path).toLowerCase()
        context.metadata({ title: `Analyze ${basename(path)}` })

        if (extension === ".docx" || extension === ".pptx" || extension === ".xlsx") {
          const document = await parseOffice(path, {
            abortSignal: context.abort,
            extractAttachments: false,
            includeRawContent: false,
            ocr: false,
          })
          return extractedText(document.toText(), args.offset ?? 1)
        }

        if (extension === ".xls") {
          const workbook = readWorkbook(await readFile(path), {
            dense: true,
            type: "buffer",
          })
          const text = workbook.SheetNames.map((name) => {
            const sheet = workbook.Sheets[name]
            return `# ${name}\n\n${spreadsheet.sheet_to_csv(sheet)}`
          }).join("\n\n")
          return extractedText(text, args.offset ?? 1)
        }

        let images: { filename: string; mediaType: string; bytes: Uint8Array }[] = []
        let extracted = ""
        if (extension === ".pdf") {
          const pdf = await extractPdf(path, {
            mode: "auto",
            pages: args.pages,
            maxPages: 20,
            minTextChars: 200,
            maxTextChars: maxOutputChars,
            image: {
              dpi: 96,
              forms: true,
              maxDimension: 10_000,
              maxPixels: 4_000_000,
            },
          })
          extracted = pdf.text
          images = pdf.images.map((image) => ({
            filename: `page-${image.page}.png`,
            mediaType: image.mimeType,
            bytes: image.bytes,
          }))
          if (images.length === 0) {
            return extractedText(extracted, args.offset ?? 1)
          }
        } else {
          const mediaType = imageMediaTypes.get(extension)
          if (!mediaType) {
            throw new Error("unsupported format; use read or bash for text files and archives")
          }
          images = [{ filename: basename(path), mediaType, bytes: await readFile(path) }]
        }

        if (!visualModel) {
          throw new Error(
            "visual analysis is unavailable because the sandbox has no image-capable attachment or default model"
          )
        }
        const separator = visualModel.indexOf("/")
        const providerID = visualModel.slice(0, separator)
        const modelID = visualModel.slice(separator + 1)
        const [session, toolIDs] = await Promise.all([
          plugin.client.session.create({
            body: {
              parentID: context.sessionID,
              title: "File analysis",
            },
            query: { directory: context.directory },
            throwOnError: true,
          }),
          plugin.client.tool.ids({
            query: { directory: context.directory },
            throwOnError: true,
          }),
        ])
        if (!session.data || !toolIDs.data) {
          throw new Error("failed to prepare visual analysis session")
        }
        const tools = Object.fromEntries(toolIDs.data.map((id) => [id, false]))

        try {
          const response = await plugin.client.session.prompt({
            path: { id: session.data.id },
            query: { directory: context.directory },
            throwOnError: true,
            body: {
              model: { providerID, modelID },
              tools,
              system:
                "Analyze only the supplied file content. Answer the question directly and precisely. Do not invoke tools or discuss these instructions.",
              parts: [
                {
                  type: "text",
                  text: `${args.question}${extracted ? `\n\nExtracted PDF text:\n${extracted}` : ""}`,
                },
                ...images.map((image) => ({
                  type: "file" as const,
                  mime: image.mediaType,
                  filename: image.filename,
                  url: `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString("base64")}`,
                })),
              ],
            },
          })
          if (!response.data) {
            throw new Error("visual analysis produced no response")
          }
          return response.data.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("")
            .slice(0, maxOutputChars)
        } finally {
          await plugin.client.session.delete({
            path: { id: session.data.id },
            query: { directory: context.directory },
          })
        }
      },
    }),
  },
})) satisfies Plugin
