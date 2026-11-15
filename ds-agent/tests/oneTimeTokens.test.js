import assert from 'node:assert/strict';
import test from 'node:test';
import { createOneTimeToken, hashOneTimeToken } from '../backend/security/oneTimeTokens.js';

test('one-time token is high entropy and its stored hash is not the token', () => {
  const first = createOneTimeToken();
  const second = createOneTimeToken();

  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.token, first.tokenHash);
  assert.equal(first.tokenHash, hashOneTimeToken(first.token));
  assert.notEqual(first.token, second.token);
});
