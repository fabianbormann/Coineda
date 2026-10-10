import type { Plugin } from 'vite';
import csp from '../../public/csp.json';

/**
 * The one policy, for the PWA (as a meta tag) and Electron (as a header,
 * see public/electron.js). The dev server additionally needs the HMR
 * websocket and localhost, which never reach a build.
 */
export const cspFor = (dev: boolean): string =>
  dev
    ? csp.policy
        .replace(
          "connect-src 'self' https:",
          `connect-src 'self' https: ${csp.devConnectSrcExtra}`,
        )
        // @vitejs/plugin-react injects an inline React Refresh preamble that
        // carries no nonce; serve mode only, never in a build.
        .replace(
          "script-src 'self'",
          `script-src 'self' ${csp.devScriptSrcExtra}`,
        )
    : csp.policy;

export const cspPlugin = (): Plugin => ({
  name: 'coineda-csp',
  transformIndexHtml(html, ctx) {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${cspFor(ctx.server !== undefined)}" />`;
    return html.replace('<head>', `<head>\n    ${meta}`);
  },
});
