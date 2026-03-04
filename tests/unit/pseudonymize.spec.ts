import { pseudonymize } from '@dicetilt/logger';

describe('pseudonymize', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.PSEUDONYM_SECRET = 'test-secret';
    process.env.PSEUDONYM_KEY_VERSION = '1';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('returns deterministic output for same userId', () => {
    const userId = '550e8400-e29b-41d4-a716-446655440000';
    expect(pseudonymize(userId)).toBe(pseudonymize(userId));
  });

  test('returns different output for different userIds', () => {
    const a = pseudonymize('user-a');
    const b = pseudonymize('user-b');
    expect(a).not.toBe(b);
  });

  test('output format is usr_<12 hex chars>', () => {
    const result = pseudonymize('test-user-id');
    expect(result).toMatch(/^usr_[a-f0-9]{12}$/);
  });

  test('different key version produces different hash', () => {
    const v1 = pseudonymize('user-1');
    process.env.PSEUDONYM_KEY_VERSION = '2';
    const v2 = pseudonymize('user-1');
    expect(v1).not.toBe(v2);
  });

  test('handles empty string', () => {
    expect(pseudonymize('')).toBe('usr_???');
  });

  test('handles invalid input', () => {
    expect(pseudonymize(null as unknown as string)).toBe('usr_???');
  });
});
