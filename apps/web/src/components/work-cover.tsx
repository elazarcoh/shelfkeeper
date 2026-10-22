import { useState } from 'react'
import { withBase } from '@/lib/base-path'
import { cn } from '@/lib/utils'

function hue(text: string): number {
  let h = 0
  for (const ch of text) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return h % 360
}

/** A copy's real cover when one was downloaded, else a generated placeholder (also when the image fails to load). */
export function WorkCover({
  title,
  coverAssetId = null,
  className,
  label = true,
}: {
  title: string
  coverAssetId?: string | null | undefined
  className?: string | undefined
  label?: boolean | undefined
}) {
  const [failed, setFailed] = useState<string | null>(null)
  if (coverAssetId !== null && failed !== coverAssetId) {
    return (
      <img
        src={withBase(`/media/${coverAssetId}`)}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailed(coverAssetId)}
        className={cn('aspect-[2/3] rounded-md object-cover shadow-sm', className)}
      />
    )
  }
  const h = hue(title)
  return (
    <div
      aria-hidden
      className={cn('flex aspect-[2/3] items-end rounded-md p-2 text-xs font-medium text-white shadow-sm', className)}
      style={{ background: `linear-gradient(160deg, hsl(${h} 45% 45%), hsl(${(h + 40) % 360} 50% 22%))` }}
    >
      {label ? (
        <span className="line-clamp-3" dir="auto">
          {title}
        </span>
      ) : null}
    </div>
  )
}
