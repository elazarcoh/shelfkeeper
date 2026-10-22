import type { ReactNode } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

/** A book title inside a sentence: isolated, so a Hebrew title does not flip the quotes and "?" around it. */
export function QuotedTitle({ title }: { title: string }) {
  return (
    <>
      “<bdi>{title}</bdi>”
    </>
  )
}

export function CheckinCard({ title, description, children }: { title: ReactNode; description?: string | undefined; children: ReactNode }) {
  return (
    <Card className="w-full md:max-w-md">
      <CardHeader>
        {/* focusable from script only: the check-in moves focus here when the previous card is resolved */}
        <CardTitle dir="auto" tabIndex={-1} data-checkin-title="" className="leading-snug break-words text-match-parent outline-none">
          {title}
        </CardTitle>
        {description !== undefined ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="grid gap-4">{children}</CardContent>
    </Card>
  )
}
