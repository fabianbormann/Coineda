import { describe, expect, it } from 'vitest';
import csp from '../public/csp.json';
import { cspPlugin } from '../src/security/cspPlugin';

const HTML = '<html><head></head><body></body></html>';

function run(server: unknown): string {
  const plugin = cspPlugin();
  const hook = plugin.transformIndexHtml as unknown as (
    html: string,
    ctx: unknown,
  ) => string;
  return hook(HTML, { path: '/index.html', filename: 'index.html', server });
}

describe('cspPlugin', () => {
  it('injects the exact policy as the first child of head on build', () => {
    const out = run(undefined);
    expect(out).toContain(`content="${csp.policy}"`);
    expect(out).toMatch(/<head>\s*<meta http-equiv="Content-Security-Policy"/);
    expect(out).not.toContain('ws:');
  });

  it('adds the websocket and localhost extra to connect-src on serve only', () => {
    expect(run({})).toContain(
      "connect-src 'self' https: ws: http://localhost:*",
    );
  });
});
