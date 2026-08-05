import { CheckCircle2 } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export default function WorkspacePage() {
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CheckCircle2 aria-hidden="true" className="text-success size-4" />
          Workspace ready
        </CardTitle>
        <CardDescription>The Workspace infrastructure is available.</CardDescription>
      </CardHeader>
      <CardContent className="text-muted-foreground">
        Workspace resources and access controls will appear here as they become available.
      </CardContent>
    </Card>
  )
}
