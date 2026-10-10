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
    const key = 'a+b/c=d+e/f=';
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

  it('leaves text alone for an empty or too-short secret', () => {
    expect(redactSecret('hello', '')).toBe('hello');
    expect(redactSecret('a banana', 'a')).toBe('a banana');
    expect(redactSecret('key=abcdefg', 'abcdefg')).toBe('key=abcdefg');
    expect(redactSecret('key=abcdefgh', 'abcdefgh')).toBe('key=[redacted]');
  });

  it('treats regex characters in the key literally', () => {
    expect(redactSecret('k=ab.cd.ef.gh z=abXcdYefZgh', 'ab.cd.ef.gh')).toBe(
      'k=[redacted] z=abXcdYefZgh',
    );
  });

  it('redacts a key that straddles char 120 before truncating', () => {
    const key = 'K7Q2M9WZ4R8T1V6Y3P5N0J2H8G4F6D1S';
    const message = messageFor(`${'.'.repeat(110)}${key} trailing`, key);
    expect(message).toContain('[redacted]');
    for (let i = 0; i + 6 <= key.length; i++) {
      expect(message).not.toContain(key.slice(i, i + 6));
    }
  });
});
