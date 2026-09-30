import { toast, type ExternalToast } from 'sonner';

/**
 * The app's notification surface. Call sites import this rather than
 * `sonner` directly, for two reasons: the toast library stays swappable
 * without touching every screen, and there is one place to see every
 * message the app can raise.
 *
 * Messages arrive ALREADY TRANSLATED. Translation belongs at the call
 * site, where `useTranslation`'s `t` is in scope with its interpolation
 * values; translating in here would need its own i18n import and could
 * not interpolate per call.
 *
 * The optional second argument forwards sonner's own options: `id` is
 * how a loading toast is later turned into a success/error one (a tax
 * run issuing one CoinGecko request per buy/sell pair needs exactly
 * this), and `action` is how a delete gets an Undo. Without it, the
 * first caller that needs either would reach past this module straight
 * into `sonner`, defeating the point of having one notification surface.
 */
export const notify = {
  success: (message: string, options?: ExternalToast) =>
    toast.success(message, options),
  error: (message: string, options?: ExternalToast) =>
    toast.error(message, options),
  warning: (message: string, options?: ExternalToast) =>
    toast.warning(message, options),
  info: (message: string, options?: ExternalToast) =>
    toast.info(message, options),
};
