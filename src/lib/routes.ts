import {
  LayoutDashboard,
  NotebookPen,
  Landmark,
  Wallet,
  Settings as SettingsIcon,
  type LucideIcon,
} from 'lucide-react';

export type AppRoute = {
  /** Hash-router path. */
  path: string;
  /** Translation key, which in this codebase is the English string. */
  titleKey: string;
  Icon: LucideIcon;
};

export const ROUTES: readonly AppRoute[] = [
  { path: '/', titleKey: 'Dashboard', Icon: LayoutDashboard },
  { path: '/tracking', titleKey: 'Tracking', Icon: NotebookPen },
  { path: '/reports', titleKey: 'Tax Reports', Icon: Landmark },
  { path: '/wallets', titleKey: 'Wallets', Icon: Wallet },
  { path: '/settings', titleKey: 'Settings', Icon: SettingsIcon },
] as const;

/**
 * Resolves a pathname to its route. Matches by prefix because the router
 * declares nested routes (`/tracking/*`), so `/tracking/anything` must
 * still resolve to Tracking rather than falling through to no title.
 * '/' is matched exactly, or it would swallow every path.
 */
export const matchRoute = (pathname: string): AppRoute | undefined => {
  if (pathname === '/' || pathname === '/dashboard') {
    return ROUTES[0];
  }
  return ROUTES.find(
    (route) =>
      route.path !== '/' &&
      (pathname === route.path || pathname.startsWith(`${route.path}/`)),
  );
};
