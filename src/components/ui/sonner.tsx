import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useTheme } from "@/components/theme/ThemeProvider"
import { Toaster as Sonner, type ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  const { resolved } = useTheme()

  return (
    <Sonner
      theme={resolved}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      toastOptions={{
        classNames: {
          // The blur half of the material. The background half rides in
          // `--normal-bg` below, because sonner paints that itself with a
          // rule of equal specificity injected at runtime - a class setting
          // `background` would win or lose depending on injection order.
          // It sets no backdrop-filter of its own, so this cannot clash.
          toast: "backdrop-blur-[28px] backdrop-saturate-150",
        },
      }}
      style={
        {
          // NOT `--popover`, which is `--lm-glass-3`: 14% white in dark
          // mode. That token is half of a material - the `glass-3` utility
          // pairs it with a 40px backdrop blur - and a toast given only the
          // background got the translucency without the blur, so the rows
          // and buttons underneath read straight through it.
          //
          // A toast is the one surface whose legibility must not depend on
          // what happens to be behind it, which is what `glass-chrome` was
          // built for: ~92% coverage, nothing behind recognisable, and a
          // sliver of blurred wash so it still belongs to its page.
          "--normal-bg": "var(--lm-chrome-bg)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
