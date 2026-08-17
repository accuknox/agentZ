"use client"

import dynamic from "next/dynamic"
import { useActionState, useEffect, useRef, useState, useTransition } from "react"
import type { Area, Point } from "react-easy-crop"
import { ImagePlus, Pencil, Save, Trash2, ZoomIn } from "lucide-react"
import { toast } from "sonner"
import {
  createOrganizationLogoUploadAction,
  type OrganizationNameFormState,
  updateOrganizationLogoAction,
  updateOrganizationNameAction,
} from "@/app/(scoped)/orgs/actions"
import type { OrganizationSummary } from "@/data/organizations"
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Field, FieldError, FieldGroup, FieldLabel, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { Spinner } from "@/components/ui/spinner"

const Cropper = dynamic(() => import("react-easy-crop"), { ssr: false })
const supportedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"])
const maximumSourceBytes = 5 * 1024 * 1024

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
  const [logo, setLogo] = useState(organization.logo)
  const [sourceURL, setSourceURL] = useState<string>()
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 })
  const [cropPixels, setCropPixels] = useState<Area>()
  const [zoom, setZoom] = useState(1)
  const [dragging, setDragging] = useState(false)
  const [photoError, setPhotoError] = useState<string>()
  const [photoPhase, setPhotoPhase] = useState<
    "idle" | "preparing" | "removing" | "saving" | "uploading"
  >("idle")
  const [photoPending, startPhotoTransition] = useTransition()
  const [state, action, pending] = useActionState<OrganizationNameFormState, FormData>(
    async (previousState) => {
      try {
        const result = await updateOrganizationNameAction(organization.id, previousState, {
          name,
        })
        if (result.saved) {
          toast.success("Organisation updated")
        }
        return result
      } catch {
        return {
          name,
          errors: { form: "The Organisation name could not be saved. Try again." },
        }
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

  function chooseImage(file?: File) {
    if (!file) {
      return
    }
    if (!supportedImageTypes.has(file.type)) {
      setPhotoError("Choose a JPEG, PNG, or WebP image.")
      return
    }
    if (file.size > maximumSourceBytes) {
      setPhotoError("Choose an image smaller than 5 MB.")
      return
    }

    setPhotoError(undefined)
    setCrop({ x: 0, y: 0 })
    setCropPixels(undefined)
    setZoom(1)
    setSourceURL(URL.createObjectURL(file))
  }

  function removeLogo() {
    setPhotoError(undefined)
    setPhotoPhase("removing")
    startPhotoTransition(async () => {
      try {
        const result = await updateOrganizationLogoAction(organization.id, { kind: "remove" })
        if ("error" in result) {
          setPhotoError(result.error)
          return
        }
        setLogo(result.logo)
        toast.success("Organisation photo removed")
      } catch {
        setPhotoError("The Organisation profile image could not be removed. Try again.")
      } finally {
        setPhotoPhase("idle")
      }
    })
  }

  function saveLogo() {
    if (!sourceURL || !cropPixels) {
      return
    }

    setPhotoError(undefined)
    setPhotoPhase("preparing")
    startPhotoTransition(async () => {
      try {
        let blob: Blob
        let hash: ArrayBuffer
        try {
          blob = await renderProfileImage(sourceURL, cropPixels)
          hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())
        } catch {
          setPhotoError("The cropped image could not be prepared. Try again.")
          return
        }
        const sha256 = Array.from(new Uint8Array(hash), (byte) =>
          byte.toString(16).padStart(2, "0")
        ).join("")

        setPhotoPhase("uploading")
        try {
          const upload = await createOrganizationLogoUploadAction({
            byteLength: blob.size,
            organizationId: organization.id,
            sha256,
          })
          if ("error" in upload) {
            setPhotoError(upload.error)
            return
          }
          const response = await fetch(upload.uploadUrl, {
            body: blob,
            headers: upload.headers,
            method: "PUT",
          })
          if (!response.ok) {
            setPhotoError("The image upload failed. Check your connection and try again.")
            return
          }
        } catch {
          setPhotoError("The image upload failed. Check your connection and try again.")
          return
        }

        setPhotoPhase("saving")
        try {
          const result = await updateOrganizationLogoAction(organization.id, {
            kind: "replace",
            sha256,
          })
          if ("error" in result) {
            setPhotoError(result.error)
            return
          }

          setLogo(result.logo)
          setSourceURL(undefined)
          toast.success("Organisation photo updated")
        } catch {
          setPhotoError("The Organisation profile image could not be saved. Try again.")
        }
      } finally {
        setPhotoPhase("idle")
      }
    })
  }

  const photoBusy = photoPending || photoPhase !== "idle"
  const busy = pending || photoBusy
  const photoStatus =
    photoPhase === "preparing"
      ? "Preparing…"
      : photoPhase === "uploading"
        ? "Uploading…"
        : photoPhase === "saving"
          ? "Saving…"
          : "Use this image"

  return (
    <>
      <form action={action} aria-label="Organisation details" className="flex min-w-0 flex-col">
        <header className="px-4 pt-5 md:px-6">
          <h1 className="text-2xl font-semibold tracking-normal">General</h1>
        </header>

        <div className="flex max-w-3xl flex-col gap-8 px-4 py-6 md:px-6 md:py-8">
          <FieldSet>
            <div
              className="border-border/70 bg-card/40 data-[dragging=true]:border-primary data-[dragging=true]:bg-primary/10 flex flex-col gap-5 rounded-xl border-2 border-dashed p-5 transition-colors sm:flex-row sm:items-center"
              data-dragging={dragging}
              onDragEnter={(event) => {
                if (busy || !event.dataTransfer.types.includes("Files")) {
                  return
                }
                event.preventDefault()
                setDragging(true)
              }}
              onDragLeave={(event) => {
                if (event.currentTarget === event.target) {
                  setDragging(false)
                }
              }}
              onDragOver={(event) => {
                if (busy || !event.dataTransfer.types.includes("Files")) {
                  return
                }
                event.preventDefault()
                event.dataTransfer.dropEffect = "copy"
                setDragging(true)
              }}
              onDrop={(event) => {
                event.preventDefault()
                setDragging(false)
                if (!busy) {
                  chooseImage(event.dataTransfer.files[0])
                }
              }}
            >
              <div className="relative shrink-0">
                <OrganizationAvatar
                  className="ring-background size-24 shadow-sm ring-4"
                  logo={logo}
                  name={name || organization.name}
                />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      aria-busy={photoBusy}
                      aria-label="Edit Organisation photo"
                      className="absolute right-0 bottom-0 rounded-full shadow-sm"
                      disabled={busy}
                      size="icon-sm"
                      type="button"
                      variant="outline"
                    >
                      {photoBusy ? <Spinner /> : <Pencil />}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" sideOffset={6}>
                    <DropdownMenuGroup>
                      <DropdownMenuItem onSelect={() => fileInput.current?.click()}>
                        <ImagePlus />
                        {logo ? "Replace photo…" : "Upload photo…"}
                      </DropdownMenuItem>
                      {logo ? (
                        <DropdownMenuItem onSelect={removeLogo} variant="destructive">
                          <Trash2 />
                          Remove photo
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-3">
                <div>
                  <p className="font-medium">{organization.name}</p>
                  <p className="text-muted-foreground mt-0.5 text-sm">
                    JPEG, PNG, or WebP · 5 MB maximum · Drop anywhere here
                  </p>
                </div>
                {!sourceURL && photoError ? (
                  <FieldError errors={[{ message: photoError }]} />
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
            </Field>
            {state.errors?.form ? <FieldError errors={[{ message: state.errors.form }]} /> : null}
          </FieldGroup>

          <div className="flex justify-end pt-5">
            <Button aria-busy={busy} disabled={busy} type="submit">
              {pending ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
              {pending ? "Saving…" : "Save changes"}
            </Button>
          </div>
          <p aria-live="polite" className="sr-only">
            {pending ? "Saving…" : state.saved ? "Organisation profile saved." : ""}
          </p>
        </div>
      </form>

      <Dialog
        onOpenChange={(open) => {
          if (!open && !photoBusy) {
            setPhotoError(undefined)
            setSourceURL(undefined)
          }
        }}
        open={Boolean(sourceURL)}
      >
        <DialogContent
          className="sm:max-w-lg"
          onEscapeKeyDown={(event) => {
            if (photoBusy) {
              event.preventDefault()
            }
          }}
          showCloseButton={!photoBusy}
        >
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
                    setPhotoError("This image could not be opened. Choose another image.")
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
              disabled={photoBusy}
              id="organization-logo-zoom"
              max={3}
              min={1}
              onValueChange={(values) => setZoom(values[0] ?? 1)}
              step={0.01}
              value={[zoom]}
            />
          </Field>
          {photoError ? <FieldError errors={[{ message: photoError }]} /> : null}
          <DialogFooter>
            <Button disabled={photoBusy} onClick={() => setSourceURL(undefined)} variant="outline">
              Cancel
            </Button>
            <Button
              data-dialog-submit
              disabled={photoBusy || !sourceURL || !cropPixels}
              onClick={saveLogo}
              type="button"
            >
              {photoBusy ? <Spinner data-icon="inline-start" /> : null}
              {photoStatus}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
