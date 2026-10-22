import { Star, StarHalf } from 'lucide-react'
import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { useMediaQuery } from '@/lib/use-media-query'
import { cn } from '@/lib/utils'
import { clickHalf, clickRating, halfAt, nextRating, shownRating, starFill, starForValue, stepRating, type StarHalf as Half } from './star-rating-logic'

interface StarRatingProps {
  value: number | null
  onChange?: ((value: number) => void) | undefined
  size?: 'sm' | 'md'
}

function StarIcon({ fill, className }: { fill: 'full' | 'half' | 'empty'; className: string }) {
  return (
    <span className="relative inline-block">
      <Star className={cn(className, 'text-muted-foreground/40')} />
      {fill === 'full' ? <Star className={cn(className, 'absolute inset-0 fill-amber-400 text-amber-400')} /> : null}
      {fill === 'half' ? <StarHalf className={cn(className, 'absolute inset-0 fill-amber-400 text-amber-400')} /> : null}
    </span>
  )
}

const STARS = [1, 2, 3, 4, 5]

/** The half of the star button under a mouse pointer. */
function pointedHalf(e: PointerEvent<HTMLButtonElement>): Half {
  const box = e.currentTarget.getBoundingClientRect()
  return halfAt(e.clientX - box.left, box.width)
}

const ratedLabel = (value: number | null) => (value === null ? 'Not rated' : `Rated ${String(value)} of 5`)

/**
 * Read-only: small stars. Interactive: five 44px stars.
 * - Touch, pen and keyboard: tap a star to set it; tap the same star again for the half.
 * - Mouse: the left half of a star gives the half, the right half the whole star (hover previews it).
 * - Arrow keys step a preview by half a star (Home and End go to the ends) without saving; Enter or Space saves
 *   it, Escape or leaving the stars drops it.
 * Nothing optimistic: the stars show the saved `value` once a save is sent, so a failed save shows the last saved value.
 * Always laid out left to right: the half targets and the half-filled icon are both the star's left half.
 */
export function StarRating({ value, onChange, size = 'md' }: StarRatingProps) {
  // read-only ratings (every Library card) stay plain markup: no state, no media-query subscription
  if (!onChange) {
    const icon = size === 'sm' ? 'size-3.5' : 'size-6'
    return (
      <div role="group" aria-label={ratedLabel(value)} dir="ltr" className="flex items-center">
        {STARS.map((star) => (
          <StarIcon key={star} fill={starFill(value ?? 0, star)} className={icon} />
        ))}
      </div>
    )
  }
  return <InteractiveStars value={value} onChange={onChange} />
}

function InteractiveStars({ value, onChange }: { value: number | null; onChange: (value: number) => void }) {
  const [hover, setHover] = useState<number | null>(null)
  // an arrow-key preview, not saved until Enter or Space
  const [preview, setPreview] = useState<number | null>(null)
  // set on a mouse's pointerdown, consumed by the click that follows
  const mouseHalf = useRef<Half | null>(null)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const hintId = useId()
  const coarse = useMediaQuery('(pointer: coarse)')

  const savedStar = starForValue(value)
  const shown = shownRating({ hover, preview, saved: value })

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape' && preview !== null) {
      e.preventDefault()
      setPreview(null)
      return
    }
    const next = stepRating(preview ?? value, e.key)
    if (next === null) return
    e.preventDefault()
    setPreview(next)
    buttons.current[(starForValue(next) ?? 1) - 1]?.focus()
  }

  return (
    // -ms-2: each 44px button centres a 28px star, so the first star lines up with the label above
    <div
      role="group"
      aria-label={ratedLabel(value)}
      dir="ltr"
      className="-ms-2 flex items-center"
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        // focus left the stars: drop an unsaved preview
        if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setPreview(null)
      }}
      onPointerLeave={() => {
        setHover(null)
        mouseHalf.current = null
      }}
    >
      <span id={hintId} className="sr-only">
        {coarse ? 'Tap a star again for a half star.' : 'Press a star again for a half star, or use the arrow keys and Enter.'}
      </span>
      <span className="sr-only" aria-live="polite">
        {preview !== null ? `${String(preview)} of 5, press Enter to save` : ratedLabel(value)}
      </span>
      {STARS.map((star) => (
        <button
          key={star}
          ref={(el) => {
            buttons.current[star - 1] = el
          }}
          type="button"
          aria-label={star === 1 ? 'Rate 1 star' : `Rate ${String(star)} stars`}
          aria-describedby={hintId}
          aria-current={star === savedStar ? 'true' : undefined}
          className="grid size-11 cursor-pointer place-items-center rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          // hover previews only with a mouse: on touch, pointer events would leave a stuck preview after the tap
          onPointerMove={(e) => (e.pointerType === 'mouse' ? setHover(nextRating(value, star, pointedHalf(e))) : undefined)}
          onPointerDown={(e) => {
            mouseHalf.current = e.pointerType === 'mouse' ? pointedHalf(e) : null
          }}
          onPointerCancel={() => {
            mouseHalf.current = null
          }}
          onClick={(e) => {
            const half = clickHalf(e.detail, mouseHalf.current)
            mouseHalf.current = null
            setHover(null)
            setPreview(null)
            onChange(clickRating({ detail: e.detail, preview, current: value, star, half }))
          }}
        >
          <StarIcon fill={starFill(shown, star)} className="size-7" />
        </button>
      ))}
    </div>
  )
}
