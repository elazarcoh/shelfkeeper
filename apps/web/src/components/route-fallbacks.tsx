import { Link, useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { AuthCard } from '@/components/page'
import { Button } from '@/components/ui/button'

/** An address that matches no page (the router's default was a bare "Not Found" in the corner). */
export function NotFoundPage() {
  return (
    <AuthCard title="Page not found" description="That address isn’t a page in My Library. It may have moved, or the link was mistyped.">
      <Button asChild className="w-full">
        <Link to="/">Go to Home</Link>
      </Button>
    </AuthCard>
  )
}

/** A page that threw while loading or rendering: say so plainly and offer a retry. */
export function RouteErrorPage({ error, reset }: ErrorComponentProps) {
  const router = useRouter()
  return (
    <AuthCard title="Something went wrong" description="This page couldn’t be shown. Trying again usually helps.">
      <div className="grid gap-3">
        {error instanceof Error && error.message !== '' ? (
          <p className="rounded-md bg-muted p-3 text-sm wrap-anywhere text-muted-foreground" dir="auto">
            {error.message}
          </p>
        ) : null}
        <Button
          className="w-full"
          onClick={() => {
            reset()
            void router.invalidate()
          }}
        >
          Try again
        </Button>
        <Button asChild variant="outline" className="w-full">
          <Link to="/">Go to Home</Link>
        </Button>
      </div>
    </AuthCard>
  )
}
