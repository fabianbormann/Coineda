import packageJSON from '../../package.json';

/**
 * The app version, read straight from package.json rather than an injected
 * env var: release-please bumps package.json and nothing else, so reading it
 * directly cannot drift from the released version. `resolveJsonModule` is
 * enabled, so this needs no build-time plumbing.
 *
 * Must stay a bare semver with no leading 'v': AppShell builds a GitHub
 * release URL as `v${APP_VERSION}` against release-please's `v<semver>`
 * tags. tests/build.test.ts pins that.
 */
export const APP_VERSION: string = packageJSON.version;
