import * as React from "react"
import { cn } from "@/lib/utils"

/**
 * shadcn styles this field's ::selection with the primary fill plus its
 * on-fill text colour. That pair is deliberately absent from the class
 * list below - and spelled out in prose rather than in the class names
 * themselves, because Tailwind scans these files as plain text and would
 * generate the very utilities this comment says are gone.
 *
 * The on-fill colour is Lumen's `--lm-on-fill`, the INVERSE of the page
 * text: #f6f7fa in light mode, #0b0c10 in dark. It pairs correctly with
 * the solid highlight behind it - but only while that highlight actually
 * paints. Typing on Android, Chrome renders the text being composed in a
 * highlight that takes the ::selection colour WITHOUT its background, so
 * every character a person typed came out near-white on white (reported
 * as "very light grey on white", and as "thin black strokes on grey" in
 * dark mode): their own input, invisible, in the field where this app
 * asks for a transfer secret that cannot be recovered.
 *
 * Left alone, the browser paints selection with its own
 * `highlight`/`highlighttext` pair, which it guarantees to be legible
 * together and which follows the `color-scheme` this app declares per
 * theme (src/index.css). A brand-coloured selection is not worth a field
 * that can hide what is typed into it.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-input glass-1 px-3 py-1 text-foreground text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
