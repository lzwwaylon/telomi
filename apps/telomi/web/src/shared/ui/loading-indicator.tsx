import { cn } from "@/shared/lib/utils"
import { uiText } from "@/app/ui-text"

export interface SpinnerProps {
  /** Additional className */
  className?: string
}

/**
 * Spinner - 3x3 grid spinner based on SpinKit Grid
 *
 * Features:
 * - Uses currentColor (inherits text color from parent)
 * - Uses em sizing (scales with font-size)
 * - 3x3 grid of cubes with staggered scale animation
 * - Pure CSS animation (no JS state)
 *
 * Usage:
 * ```tsx
 * // Inherits color and size from parent
 * <div className="text-muted-foreground text-sm">
 *   <Spinner />
 * </div>
 *
 * // Or override with className
 * <Spinner className="text-amber-500 text-lg" />
 * ```
 */
export function Spinner({ className }: SpinnerProps) {
  return (
    <span
      className={cn("spinner", className)}
      role="status"
		  aria-label={uiText("schedule.loading")}
    >
      <span className="spinner-cube" />
      <span className="spinner-cube" />
      <span className="spinner-cube" />
      <span className="spinner-cube" />
      <span className="spinner-cube" />
      <span className="spinner-cube" />
      <span className="spinner-cube" />
      <span className="spinner-cube" />
      <span className="spinner-cube" />
    </span>
  )
}
