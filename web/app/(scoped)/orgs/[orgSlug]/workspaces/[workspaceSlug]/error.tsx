"use client"

import { AdministrationState } from "@/components/administration"

export default function ErrorPage() {
  return <AdministrationState kind="failed" title="Unable to load Workspace" />
}
