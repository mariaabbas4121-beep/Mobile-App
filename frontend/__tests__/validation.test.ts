import { emailError, newPasswordErrors, normaliseEmail, utf8ByteLength, validateLogin, validateSignup } from '../lib/auth/validation';

const valid = { displayName: 'Sara', email: 'sara@example.com', password: 'correct1horse', confirmPassword: 'correct1horse' };

describe('signup validation (mirrors backend rules)', () => {
  test('accepts a valid form', () => {
    expect(validateSignup(valid)).toEqual({});
  });

  test('normalises email like the backend (trim + lower-case)', () => {
    expect(normaliseEmail('  Sara@Example.COM ')).toBe('sara@example.com');
    expect(emailError('  Sara@Example.COM ')).toBeNull();
  });

  test.each([
    ['empty', ''],
    ['no @', 'sara.example.com'],
    ['no domain dot', 'sara@example'],
    ['spaces', 'sa ra@example.com'],
    ['too long', `${'a'.repeat(250)}@x.co`],
  ])('rejects email: %s', (_l, email) => {
    expect(validateSignup({ ...valid, email }).email).toBeTruthy();
  });

  test.each([
    ['shorter than 8', 'abc1', 'at least 8'],
    ['no digit', 'onlyletters', 'letter and one number'],
    ['no letter', '1234567890', 'letter and one number'],
  ])('rejects password %s', (_l, password, message) => {
    expect(validateSignup({ ...valid, password, confirmPassword: password }).password).toContain(message);
  });

  test('enforces the 72-byte UTF-8 limit, not 72 characters', () => {
    const fortyAccented = `a1${'é'.repeat(40)}`; // 42 characters, 82 bytes
    expect(fortyAccented.length).toBeLessThan(72);
    expect(utf8ByteLength(fortyAccented)).toBe(82);
    expect(newPasswordErrors(fortyAccented)).toContain('Password is too long.');
    expect(newPasswordErrors(`a1${'b'.repeat(70)}`)).toEqual([]); // exactly 72 bytes
  });

  test('counts letters and digits beyond ASCII like the backend (\\p{L}, \\p{Nd})', () => {
    expect(newPasswordErrors('пароль١٢٣')).toEqual([]);
  });

  test('requires matching confirmation', () => {
    expect(validateSignup({ ...valid, confirmPassword: 'different1' }).confirmPassword).toBe('Passwords do not match.');
    expect(validateSignup({ ...valid, confirmPassword: '' }).confirmPassword).toBe('Confirm your password.');
  });

  test.each([
    ['missing', ''],
    ['one character', 'A'],
    ['over 50 characters', 'x'.repeat(51)],
  ])('rejects display name: %s', (_l, displayName) => {
    expect(validateSignup({ ...valid, displayName }).displayName).toBeTruthy();
  });
});

describe('login validation', () => {
  test('does not apply the signup password policy', () => {
    expect(validateLogin({ email: 'a@example.com', password: 'short' })).toEqual({});
  });

  test('requires both fields', () => {
    expect(validateLogin({ email: '', password: '' })).toEqual({
      email: 'Enter your email address.',
      password: 'Enter your password.',
    });
  });
});
