"use client"

import dynamic from "next/dynamic"
import { useActionState, useEffect, useRef, useState } from "react"
import type { Area, Point } from "react-easy-crop"
import { Globe2, ImagePlus, Save, Trash2, ZoomIn } from "lucide-react"
import { toast } from "sonner"
import {
  createOrganizationLogoUploadAction,
  type OrganizationProfileFormState,
  updateOrganizationProfileAction,
} from "@/app/(scoped)/orgs/actions"
import type { OrganizationSummary } from "@/data/organizations"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { OrganizationAvatar } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { Spinner } from "@/components/ui/spinner"

const Cropper = dynamic(() => import("react-easy-crop"), { ssr: false })
const supportedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"])
const maximumSourceBytes = 5 * 1024 * 1024

type LogoEdit =
  | { kind: "unchanged" }
  | { kind: "remove" }
  | { blob: Blob; kind: "replace"; previewURL: string }

async function renderProfileImage(imageURL: string, crop: Area): Promise<Blob> {
  const image = new Image()
  image.src = imageURL
  await image.decode()

  const canvas = document.createElement("canvas")
  canvas.width = 1024
  canvas.height = 1024
  const context = canvas.getContext("2d")
  if (!context) {
    throw new Error("Canvas is unavailable")
  }
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = "high"
  context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, 1024, 1024)

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob)
          return
        }
        reject(new Error("WebP encoding failed"))
      },
      "image/webp",
      0.9
    )
  })
}

export function OrganizationForm({ organization }: { organization: OrganizationSummary }) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(organization.name)
  const [logo, setLogo] = useState<LogoEdit>({ kind: "unchanged" })
  const [sourceURL, setSourceURL] = useState<string>()
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 })
  const [cropPixels, setCropPixels] = useState<Area>()
  const [zoom, setZoom] = useState(1)
  const [cropping, setCropping] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [phase, setPhase] = useState<"idle" | "uploading" | "saving">("idle")
  const [state, action, pending] = useActionState<OrganizationProfileFormState, FormData>(
    async (previousState) => {
      try {
        let logoInput:
          | { kind: "unchanged" }
          | { kind: "remove" }
          | { kind: "replace"; sha256: string }
        if (logo.kind === "remove") {
          logoInput = { kind: "remove" }
        } else {
          logoInput = { kind: "unchanged" }
        }
        if (logo.kind === "replace") {
          setPhase("uploading")
          const hash = await crypto.subtle.digest("SHA-256", await logo.blob.arrayBuffer())
          const sha256 = Array.from(new Uint8Array(hash), (byte) =>
            byte.toString(16).padStart(2, "0")
          ).join("")
          const upload = await createOrganizationLogoUploadAction({
            byteLength: logo.blob.size,
            organizationId: organization.id,
            sha256,
          })
          if ("error" in upload) {
            return { name, errors: { form: upload.error } }
          }

          let response: Response
          try {
            response = await fetch(upload.uploadUrl, {
              body: logo.blob,
              headers: upload.headers,
              method: "PUT",
            })
          } catch {
            return {
              name,
              errors: { form: "The image upload failed. Check your connection and try again." },
            }
          }
          if (!response.ok) {
            return {
              name,
              errors: { form: "The image upload failed. Check your connection and try again." },
            }
          }
          logoInput = { kind: "replace", sha256 }
        }

        setPhase("saving")
        const result = await updateOrganizationProfileAction(organization.id, previousState, {
          logo: logoInput,
          name,
        })
        if (result.saved) {
          setLogo({ kind: "unchanged" })
          toast.success("Organisation updated")
        }
        return result
      } catch {
        return {
          name,
          errors: { form: "The Organisation profile could not be saved. Try again." },
        }
      } finally {
        setPhase("idle")
      }
    },
    { name: organization.name }
  )

  useEffect(() => {
    return () => {
      if (sourceURL) {
        URL.revokeObjectURL(sourceURL)
      }
    }
  }, [sourceURL])

  useEffect(() => {
    return () => {
      if (logo.kind === "replace") {
        URL.revokeObjectURL(logo.previewURL)
      }
    }
  }, [logo])

  function chooseImage(file: File | undefined) {
    if (!file) {
      return
    }
    if (!supportedImageTypes.has(file.type)) {
      toast.error("Choose a JPEG, PNG, or WebP image.")
      return
    }
    if (file.size > maximumSourceBytes) {
      toast.error("Choose an image smaller than 5 MB.")
      return
    }

    setCrop({ x: 0, y: 0 })
    setCropPixels(undefined)
    setZoom(1)
    setSourceURL(URL.createObjectURL(file))
  }

  const displayedLogo =
    logo.kind === "replace" ? logo.previewURL : logo.kind === "remove" ? null : organization.logo
  const busy = pending || phase !== "idle"
  const status =
    phase === "uploading" ? "Uploading…" : phase === "saving" ? "Saving…" : "Save changes"

  return (
    <>
      <form action={action} aria-label="Organisation details" className="flex min-w-0 flex-col">
        <header className="border-border/60 border-b px-4 py-5 md:px-6">
          <h1 className="text-2xl font-semibold tracking-normal">General</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Shape how your Organisation appears across AgentZ.
          </p>
        </header>

        <div className="flex max-w-3xl flex-col gap-8 px-4 py-6 md:px-6 md:py-8">
          <FieldSet>
            <FieldLegend>Profile picture</FieldLegend>
            <FieldDescription>
              A clear square image works best. You’ll be able to position and crop it before saving.
            </FieldDescription>
            <div
              className="border-border/70 bg-card/40 data-[dragging=true]:border-primary/50 data-[dragging=true]:bg-primary/5 flex flex-col gap-5 rounded-xl border p-5 transition-colors sm:flex-row sm:items-center"
              data-dragging={dragging}
              onDragEnter={(event) => {
                event.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault()
                setDragging(false)
                if (!busy) {
                  chooseImage(event.dataTransfer.files[0])
                }
              }}
            >
              <OrganizationAvatar
                className="ring-background size-24 shadow-sm ring-4"
                logo={displayedLogo}
                name={name || organization.name}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-3">
                <div>
                  <p className="font-medium">{organization.name}</p>
                  <p className="text-muted-foreground mt-0.5 text-sm">
                    JPEG, PNG, or WebP · 5 MB maximum · drop anywhere here
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={busy}
                    onClick={() => fileInput.current?.click()}
                    type="button"
                    variant="outline"
                  >
                    <ImagePlus data-icon="inline-start" />
                    {displayedLogo ? "Replace image" : "Upload image"}
                  </Button>
                  {displayedLogo ? (
                    <Button
                      disabled={busy}
                      onClick={() => setLogo({ kind: "remove" })}
                      type="button"
                      variant="destructive"
                    >
                      <Trash2 data-icon="inline-start" />
                      Remove
                    </Button>
                  ) : null}
                  <input
                    accept="image/jpeg,image/png,image/webp"
                    className="sr-only"
                    disabled={busy}
                    onChange={(event) => {
                      chooseImage(event.currentTarget.files?.[0])
                      event.currentTarget.value = ""
                    }}
                    ref={fileInput}
                    type="file"
                  />
                </div>
              </div>
            </div>
            <Alert className="rounded-lg border-x" variant="info">
              <Globe2 aria-hidden="true" />
              <AlertTitle>Public image</AlertTitle>
              <AlertDescription>
                Anyone with the image link can view it, including people who are not signed in.
              </AlertDescription>
            </Alert>
          </FieldSet>

          <FieldGroup>
            <Field data-invalid={Boolean(state.errors?.name)}>
              <FieldLabel htmlFor="organization-name" required>
                Name
              </FieldLabel>
              <Input
                aria-invalid={Boolean(state.errors?.name)}
                disabled={busy}
                id="organization-name"
                maxLength={100}
                onChange={(event) => setName(event.currentTarget.value)}
                required
                value={name}
              />
              {state.errors?.name ? (
                <FieldError errors={state.errors.name.map((message) => ({ message }))} />
              ) : null}
            </Field>
            <Field data-disabled>
              <FieldLabel htmlFor="organization-slug">Slug</FieldLabel>
              <Input
                autoCapitalize="none"
                autoCorrect="off"
                defaultValue={organization.slug}
                disabled
                id="organization-slug"
                spellCheck={false}
              />
              <FieldDescription>The Organisation slug cannot be changed.</FieldDescription>
            </Field>
            {state.errors?.form ? <FieldError errors={[{ message: state.errors.form }]} /> : null}
          </FieldGroup>

          <div className="flex justify-end border-t pt-5">
            <Button aria-busy={busy} disabled={busy} type="submit">
              {busy ? <Spinner /> : <Save data-icon="inline-start" />}
              {status}
            </Button>
          </div>
          <p aria-live="polite" className="sr-only">
            {busy ? status : state.saved ? "Organisation profile saved." : ""}
          </p>
        </div>
      </form>

      <Dialog
        onOpenChange={(open) => {
          if (!open && !cropping) {
            setSourceURL(undefined)
          }
        }}
        open={Boolean(sourceURL)}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Position your profile picture</DialogTitle>
            <DialogDescription>
              Drag the image inside the circle and use the slider to adjust its size.
            </DialogDescription>
          </DialogHeader>
          <div className="bg-muted relative h-80 overflow-hidden rounded-lg">
            {sourceURL ? (
              <Cropper
                aspect={1}
                crop={crop}
                cropShape="round"
                cropperProps={{ "aria-label": "Crop profile picture" }}
                classes={{}}
                image={sourceURL}
                keyboardStep={1}
                maxZoom={3}
                mediaProps={{
                  onError: () => {
                    toast.error("This image could not be opened.")
                    setSourceURL(undefined)
                  },
                }}
                onCropChange={setCrop}
                onCropComplete={(_, pixels) => setCropPixels(pixels)}
                onZoomChange={setZoom}
                minZoom={1}
                restrictPosition
                rotation={0}
                roundCropAreaPixels
                showGrid={false}
                style={{}}
                zoom={zoom}
                zoomSpeed={0.1}
              />
            ) : null}
          </div>
          <Field>
            <FieldLabel htmlFor="organization-logo-zoom">
              <ZoomIn aria-hidden="true" />
              Zoom
            </FieldLabel>
            <Slider
              aria-label="Zoom profile picture"
              disabled={cropping}
              id="organization-logo-zoom"
              max={3}
              min={1}
              onValueChange={(values) => setZoom(values[0] ?? 1)}
              step={0.01}
              value={[zoom]}
            />
          </Field>
          <DialogFooter>
            <Button disabled={cropping} onClick={() => setSourceURL(undefined)} variant="outline">
              Cancel
            </Button>
            <Button
              data-dialog-submit
              disabled={cropping || !sourceURL || !cropPixels}
              onClick={async () => {
                if (!sourceURL || !cropPixels) {
                  return
                }
                setCropping(true)
                try {
                  const blob = await renderProfileImage(sourceURL, cropPixels)
                  setLogo({ blob, kind: "replace", previewURL: URL.createObjectURL(blob) })
                  setSourceURL(undefined)
                } catch {
                  toast.error("The cropped image could not be prepared.")
                } finally {
                  setCropping(false)
                }
              }}
              type="button"
            >
              {cropping ? <Spinner /> : null}
              {cropping ? "Preparing…" : "Use this image"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
