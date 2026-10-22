import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type Announcements, type DragEndEvent, type Modifier, type UniqueIdentifier } from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowDown, ArrowUp, EllipsisVertical, GripVertical, X } from 'lucide-react'
import type { WorkCard } from '@mylib/domain'
import { returnFocusProps } from '@/components/dialog-focus'
import { focusAfterRemoval, useRemovalFocus } from '@/components/removal-focus'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { WorkCover } from '@/components/work-cover'
import { trpc } from '@/lib/trpc'
import { cn } from '@/lib/utils'
import { UP_NEXT_HEADING_ID } from './ids'
import { inOrder } from './queue-order'

// a row moves up and down only; sideways would drift it out of the list
const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 })

const SCREEN_READER_INSTRUCTIONS = {
  draggable: 'To move a book, press Space or Enter on its handle, move it with the arrow keys, then press Space or Enter to drop it, or Escape to cancel.',
}

export function QueueList({ items }: { items: WorkCard[] }) {
  const queryClient = useQueryClient()
  // returned, so a reorder stays pending until the refetched list is in (no flash of the old order)
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.library.pathKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.catalog.pathKey() }),
    ])
  const reorder = useMutation(trpc.tracking.queueReorder.mutationOptions({ onSettled: refresh }))
  const remove = useMutation(trpc.tracking.queueRemove.mutationOptions({ onSettled: refresh }))
  // while a reorder saves, show the order it asked for (#11)
  const shown = reorder.isPending ? inOrder(items, reorder.variables.workIds) : items
  const ids = shown.map((i) => i.id)
  const sensors = useSensors(
    // a few px before a drag starts, so a tap on the handle is not a drag
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function move(index: number, delta: -1 | 1) {
    const target = index + delta
    if (target < 0 || target >= ids.length) return
    reorder.mutate({ workIds: arrayMove(ids, index, target) })
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from === -1 || to === -1) return
    reorder.mutate({ workIds: arrayMove(ids, from, to) })
  }

  const title = (id: UniqueIdentifier) => shown.find((c) => c.id === id)?.title ?? 'The book'
  const position = (id: UniqueIdentifier) => `position ${String(ids.indexOf(String(id)) + 1)} of ${String(ids.length)}`
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${title(active.id)}, at ${position(active.id)}.`,
    onDragOver: ({ active, over }) => (over ? `${title(active.id)} is over ${position(over.id)}.` : `${title(active.id)} is outside the list.`),
    onDragEnd: ({ active, over }) => (over ? `${title(active.id)} dropped at ${position(over.id)}.` : `${title(active.id)} dropped where it was.`),
    onDragCancel: ({ active }) => `Moving ${title(active.id)} was cancelled; it is back at ${position(active.id)}.`,
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[verticalOnly]}
      onDragEnd={onDragEnd}
      accessibility={{ announcements, screenReaderInstructions: SCREEN_READER_INSTRUCTIONS }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ol className="divide-y rounded-lg border">
          {shown.map((card, i) => (
            <QueueRow
              key={card.id}
              card={card}
              position={i + 1}
              canDrag={shown.length > 1 && !reorder.isPending}
              canMoveUp={i > 0 && !reorder.isPending}
              canMoveDown={i < shown.length - 1 && !reorder.isPending}
              onMove={(delta) => move(i, delta)}
              onRemove={(onError) => remove.mutate({ workId: card.id }, { onError })}
            />
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  )
}

// After a removal focus goes to the next row's remove control (✕ from sm, ⋯ below it; the hidden copy is skipped), else
// the "Up next" heading
const REMOVE_CONTROL = '[data-queue-remove]'

function QueueRow({
  card,
  position,
  canDrag,
  canMoveUp,
  canMoveDown,
  onMove,
  onRemove,
}: {
  card: WorkCard
  position: number
  canDrag: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  onMove: (delta: -1 | 1) => void
  onRemove: (onError: () => void) => void
}) {
  // the menu's close focus: ⋯, repointed when Remove is chosen because this row (and its ⋯) is about to go
  const menuFocus = useRemovalFocus()
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: card.id, disabled: !canDrag })
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      // the lifted row paints over its neighbours (and the list's dividers) while it moves
      className={cn('flex min-w-0 items-center gap-2 bg-background p-3 sm:gap-3', isDragging && 'relative z-10 rounded-lg shadow-lg')}
    >
      {/* the handle alone starts a drag (touch-none: a finger on it drags instead of scrolling); the rest of the row
          still scrolls the page and opens the book */}
      <Button
        ref={setActivatorNodeRef}
        variant="ghost"
        size="icon"
        className="-ml-2 shrink-0 cursor-grab touch-none text-muted-foreground active:cursor-grabbing"
        aria-label={`Reorder ${card.title}`}
        // never `disabled` while a reorder saves: a keyboard drop would lose its focus (useSortable sets aria-disabled)
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4" />
      </Button>
      <span className="w-5 shrink-0 text-center text-sm text-muted-foreground sm:w-6">{position}</span>
      <WorkCover title={card.title} coverAssetId={card.coverAssetId} label={false} className="w-10 shrink-0" />
      <Link to="/books/$workId" params={{ workId: card.id }} className="min-w-0 flex-1">
        <p className="truncate font-medium" dir="auto">
          {card.title}
        </p>
        <p className="truncate text-sm text-muted-foreground" dir="auto">
          {card.authors.join(', ')}
        </p>
      </Link>
      <div className="hidden shrink-0 items-center sm:flex">
        <Button variant="ghost" size="icon" aria-label={`Move ${card.title} up`} disabled={!canMoveUp} onClick={() => onMove(-1)}>
          <ArrowUp className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" aria-label={`Move ${card.title} down`} disabled={!canMoveDown} onClick={() => onMove(1)}>
          <ArrowDown className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Remove ${card.title} from Up next`}
          data-queue-remove
          onClick={(e) => {
            onRemove(focusAfterRemoval(e.currentTarget, REMOVE_CONTROL, UP_NEXT_HEADING_ID))
          }}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="shrink-0 sm:hidden">
        <DropdownMenu onOpenChange={menuFocus.onOpenChange}>
          <DropdownMenuTrigger asChild>
            <Button ref={menuFocus.triggerRef} variant="ghost" size="icon" aria-label={`Actions for ${card.title}`} data-queue-remove>
              <EllipsisVertical className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" {...returnFocusProps(menuFocus.closeFocus)}>
            <DropdownMenuItem disabled={!canMoveUp} onSelect={() => onMove(-1)}>
              <ArrowUp /> Move up
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!canMoveDown} onSelect={() => onMove(1)}>
              <ArrowDown /> Move down
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => {
                menuFocus.retarget(REMOVE_CONTROL, UP_NEXT_HEADING_ID)
                onRemove(menuFocus.restore)
              }}
            >
              <X /> Remove from Up next
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  )
}
