import { describe, it, expect } from 'vitest';
import { asJson, redactSecret } from '@/sources/bitpanda/translator';

const messageFor = (body: string, key: string): string => {
  try {
    asJson({ status: 502, body }, 'the test list', key);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected asJson to throw');
};

describe('bitpanda error redaction', () => {
  it('redacts a plain key', () => {
    const message = messageFor(
      '<html>bad key=ABC123SECRET</html>',
      'ABC123SECRET',
    );
    expect(message).toContain('[redacted]');
    expect(message).not.toContain('ABC123SECRET');
  });

  it('redacts a URL-encoded key with special characters', () => {
    const key = 'a+b/c=';
    const message = messageFor(`oops ?key=${encodeURIComponent(key)} end`, key);
    expect(message).toContain('[redacted]');
    expect(message).not.toContain('a%2Bb%2Fc%3D');
    expect(message).not.toContain(key);
  });

  it('redacts a key echoed in a different case', () => {
    const message = messageFor('echo abc123secret', 'ABC123SECRET');
    expect(message).toContain('[redacted]');
    expect(message.toLowerCase()).not.toContain('abc123secret');
  });

  it('leaves text alone for an empty secret', () => {
    expect(redactSecret('hello', '')).toBe('hello');
  });
});
