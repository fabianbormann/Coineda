import packageJSON from '../../package.json';

/**
 * The app version, read straight from package.json rather than an injected
 * env var. src/helper/export.js already imports package.json this way, and
 * resolveJsonModule is enabled, so this follows existing practice.
 */
export const APP_VERSION: string = packageJSON.version;
