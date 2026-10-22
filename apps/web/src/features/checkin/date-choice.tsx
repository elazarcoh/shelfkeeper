import type { DatePrecision } from '@mylib/domain'
import { NativeSelect } from '@/components/native-select'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { addDaysLocal, todayLocal } from '@/lib/format'
import { dayAllowed, recentYears, YEARS_BACK, yearOf } from './date-options'

export interface DateChoiceValue {
  date: string
  precision: DatePrecision
}

interface DateChoiceProps {
  value: DateChoiceValue
  onChange: (v: DateChoiceValue) => void
  /** a finish: the earliest day of the session's start, so no picker offers a day before it */
  minDate?: string | undefined
  /** shown under "Don't remember" when it is picked (a finish: what an unknown date means for stats) */
  unknownNote?: string | undefined
  /** only a day: no month, year or unknown (finishing a volume has an exact end point) */
  dayOnly?: boolean | undefined
}

export function DateChoice({ value, onChange, minDate, unknownNote, dayOnly = false }: DateChoiceProps) {
  const today = todayLocal()
  const yesterday = addDaysLocal(-1)
  return (
    <div className="grid gap-2">
      {/* phones: a two-column grid instead of a ragged wrap */}
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        <Button
          type="button"
          size="sm"
          variant={value.precision === 'day' && value.date === today ? 'default' : 'outline'}
          onClick={() => onChange({ date: today, precision: 'day' })}
        >
          Today
        </Button>
        <Button
          type="button"
          size="sm"
          variant={value.precision === 'day' && value.date === yesterday ? 'default' : 'outline'}
          disabled={!dayAllowed(yesterday, minDate)}
          onClick={() => onChange({ date: yesterday, precision: 'day' })}
        >
          Yesterday
        </Button>
        {dayOnly ? null : (
          <>
            <Button
              type="button"
              size="sm"
              variant={value.precision === 'month' ? 'default' : 'outline'}
              onClick={() => onChange({ date: `${today.slice(0, 7)}-01`, precision: 'month' })}
            >
              Sometime this month
            </Button>
            <Button
              type="button"
              size="sm"
              variant={value.precision === 'year' ? 'default' : 'outline'}
              onClick={() => onChange(yearOf(Number(today.slice(0, 4))))}
            >
              In a year…
            </Button>
            {/* the fifth button takes the whole phone row instead of sitting alone in a half */}
            <Button
              type="button"
              size="sm"
              className="col-span-2 sm:col-span-1"
              variant={value.precision === 'unknown' ? 'default' : 'outline'}
              onClick={() => onChange({ date: today, precision: 'unknown' })}
            >
              Don't remember
            </Button>
          </>
        )}
      </div>
      {value.precision === 'unknown' && unknownNote !== undefined ? <p className="text-sm text-muted-foreground">{unknownNote}</p> : null}
      {value.precision === 'year' ? (
        <NativeSelect aria-label="Year" value={value.date.slice(0, 4)} onChange={(e) => onChange(yearOf(Number(e.target.value)))}>
          {recentYears(today, YEARS_BACK, minDate).map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </NativeSelect>
      ) : null}
      {value.precision === 'day' ? (
        <Input
          type="date"
          aria-label="Exact date"
          value={value.date}
          min={minDate}
          max={today}
          onChange={(e) => onChange({ date: e.target.value, precision: 'day' })}
        />
      ) : null}
      {value.precision === 'month' ? (
        <Input
          type="month"
          aria-label="Month"
          value={value.date.slice(0, 7)}
          min={minDate?.slice(0, 7)}
          max={today.slice(0, 7)}
          onChange={(e) => onChange({ date: `${e.target.value}-01`, precision: 'month' })}
        />
      ) : null}
    </div>
  )
}
