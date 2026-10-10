const {
  app,
  BrowserWindow,
  nativeImage,
  protocol,
  net,
  session,
  shell,
} = require('electron');
const path = require('path');
const url = require('url');
// The one Content-Security-Policy, shared with the PWA (see vite.config.ts).
const { policy } = require('./csp.json');

// This file lives at "public/electron.js" both in the repo and inside the
// packaged app (electron-builder's `files` config keeps that path, see
// package.json), sitting next to the bundled app in the sibling "build/"
// directory. __dirname is the "public" folder either way, so the actual
// app root (index.html, assets/, icons/ built output) is one level up.
const BUILD_DIR = path.join(__dirname, '..', 'build');

// Vite emits `<script type="module" crossorigin>` tags. Modules and
// crossorigin fetches are blocked by the browser's CORS checks when the
// document has a null origin, which is what a packaged app gets from
// loading the build directly off the local filesystem — that renders a
// blank window. Serving the build over a custom "standard" + "secure"
// scheme instead gives it a real origin, which is the supported fix (as
// opposed to disabling web security).
//
// registerSchemesAsPrivileged MUST run before app.whenReady().
const APP_SCHEME = 'coineda';

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

// frame-ancestors is ignored in a <meta> policy; it is enforced here, by the
// header (and only documented for the GitHub Pages deployment).
function withCsp(response) {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', policy);
  return new Response(response.body, { status: response.status, headers });
}

const isDev = !app.isPackaged;

// Is this URL the app itself? Node's WHATWG URL reports origin 'null' for a
// non-special scheme such as coineda:// (registerSchemesAsPrivileged only
// changes Chromium's parser), so production compares protocol and host.
// Anything unparsable is not the app.
function isAppUrl(target) {
  try {
    const u = new URL(target);
    return isDev
      ? u.origin === 'http://localhost:3000'
      : u.protocol === 'coineda:' && u.host === 'app';
  } catch {
    return false;
  }
}

function createWindow() {
  const image = nativeImage.createFromPath(
    path.join(__dirname, 'icons', 'icon.png'),
  );

  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    title: 'Coineda',
    icon: image,
    webPreferences: {
      devTools: isDev,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // External links open in the user's browser, never in an app window.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    try {
      const { protocol: proto } = new URL(target);
      // A failure (no default browser) must not become an unhandled
      // rejection in the main process.
      if (['http:', 'https:'].includes(proto)) {
        shell.openExternal(target).catch(() => {});
      }
    } catch {
      // not a URL: deny silently
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (!isAppUrl(target)) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', (event) =>
    event.preventDefault(),
  );

  mainWindow.setMenu(null);
  mainWindow.loadURL(
    isDev ? 'http://localhost:3000' : `${APP_SCHEME}://app/index.html`,
  );
  mainWindow.maximize();
}

app.whenReady().then(() => {
  // Electron grants every permission request by default. The only one the
  // app needs is the camera, for the QR scanner on the onboarding screen
  // (src/onboarding/ImportCheckpoint.tsx, offered in this build too), so
  // 'media' is allowed for video only and only to the app itself; every
  // other permission (microphone, geolocation, notifications, ...) is
  // denied.
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      const mediaTypes = details.mediaTypes ?? [];
      callback(
        permission === 'media' &&
          mediaTypes.length > 0 &&
          mediaTypes.every((type) => type === 'video') &&
          isAppUrl(details.requestingUrl),
      );
    },
  );
  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin) =>
      permission === 'media' && isAppUrl(requestingOrigin),
  );

  protocol.handle(APP_SCHEME, async (request) => {
    const { host, pathname } = new URL(request.url);

    // The host is the "app" in coineda://app/index.html. Without this check
    // coineda://anything-else/index.html would serve the exact same files
    // under a different origin, handing the app a second, unrelated
    // IndexedDB/localStorage bucket for free.
    if (host !== 'app') {
      return withCsp(new Response('Forbidden', { status: 403 }));
    }

    // pathname is e.g. "/" (root, wired to index.html), "/index.html" or
    // "/assets/index-abcd.js". The build's relative "./assets/..." URLs
    // resolve against this scheme's root, same as they would under http(s).
    let relativePath;
    try {
      relativePath =
        pathname === '/' ? 'index.html' : decodeURIComponent(pathname);
    } catch {
      // decodeURIComponent throws a URIError on malformed escapes (e.g. a
      // stray "%zz"). Without this, a bad request would reject the handler
      // instead of returning a response.
      return withCsp(new Response('Bad Request', { status: 400 }));
    }
    // path.join (not path.resolve) — relativePath has a leading "/" from the
    // URL, and path.resolve would treat that as absolute and discard
    // BUILD_DIR entirely, which is the exact file:// footgun this handler
    // exists to avoid. path.join already normalizes the result, so no
    // separate path.normalize call is needed.
    const pathToServe = path.join(BUILD_DIR, relativePath);

    // Guard against path traversal (e.g. coineda://app/../../secret.txt):
    // the resolved path must stay inside the build directory.
    const relativeToRoot = path.relative(BUILD_DIR, pathToServe);
    const isSafe =
      relativeToRoot === '' ||
      (!relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot));
    if (!isSafe) {
      return withCsp(new Response('Forbidden', { status: 403 }));
    }

    return withCsp(await net.fetch(url.pathToFileURL(pathToServe).toString()));
  });

  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
