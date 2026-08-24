import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KaiPlatformResponseError,
  decodeKaiPlatformConsent,
  decodeKaiPlatformLegal,
  decodeKaiPlatformLegalBootstrap,
  decodeKaiPlatformProfile,
} from '../src/kai-platform-session.ts';

const profileResponse = {
  ok: true,
  user: {
    id: 'user-123',
    displayName: 'KAI User',
    phone: null,
    email: 'u***@example.com',
    role: 'member',
    status: 'active',
    createdAt: '2026-08-21T02:00:00.000Z',
  },
};

const legalResponse = {
  ok: true,
  operator: { legalEntityName: '上海凯域信息科技有限公司' },
  documents: {
    terms: { version: '2026-08-11', url: 'https://cloudpay.kai.com/legal/terms' },
    privacy: { version: '2026-08-11', url: 'https://cloudpay.kai.com/legal/privacy' },
    inquiry: { version: '2026-08-11', url: null },
  },
};

test('valid platform JSON becomes the only profile, legal and consent session input', () => {
  const profile = decodeKaiPlatformProfile(profileResponse);
  const legal = decodeKaiPlatformLegalBootstrap(legalResponse);
  const documents = decodeKaiPlatformLegal(legalResponse);
  assert.equal(profile.id, 'user-123');
  assert.equal(legal.operator.legalEntityName, '上海凯域信息科技有限公司');
  assert.equal(documents.inquiry.url, null);
  assert.deepEqual(decodeKaiPlatformConsent({
    ok: true,
    accepted: { termsVersion: documents.terms.version, privacyVersion: documents.privacy.version },
    replayed: false,
  }, documents), { replayed: false });
});

test('legal bootstrap requires an exact, printable and trimmed operator name', () => {
  for (const operator of [
    {},
    { legalEntityName: '' },
    { legalEntityName: ' 上海凯域信息科技有限公司' },
    { legalEntityName: '上海凯域\n信息科技有限公司' },
    { legalEntityName: '上'.repeat(201) },
    { legalEntityName: '上海凯域信息科技有限公司', registration: 'not-accepted' },
  ]) {
    assert.throws(() => decodeKaiPlatformLegalBootstrap({ ...legalResponse, operator }), KaiPlatformResponseError);
  }
  assert.throws(() => decodeKaiPlatformLegalBootstrap({ ...legalResponse, extra: true }), KaiPlatformResponseError);
});

test('HTML or non-object mobile responses cannot create a platform session', () => {
  for (const value of [
    '<!doctype html><html><body>nginx</body></html>',
    ['unexpected'],
    null,
  ]) {
    assert.throws(() => decodeKaiPlatformProfile(value), KaiPlatformResponseError);
    assert.throws(() => decodeKaiPlatformLegal(value), KaiPlatformResponseError);
  }
});

test('platform identity bootstrap rejects missing, extra and unsafe fields', () => {
  assert.throws(() => decodeKaiPlatformProfile({
    ...profileResponse,
    user: { ...profileResponse.user, accessToken: 'must-not-be-accepted' },
  }), KaiPlatformResponseError);
  const { email: _email, ...missingEmail } = profileResponse.user;
  assert.throws(() => decodeKaiPlatformProfile({ ...profileResponse, user: missingEmail }), KaiPlatformResponseError);
  assert.throws(() => decodeKaiPlatformProfile({
    ...profileResponse,
    user: { ...profileResponse.user, createdAt: 'not-a-date' },
  }), KaiPlatformResponseError);
});

test('legal bootstrap requires exact HTTPS terms/privacy and permits nullable inquiry URL only', () => {
  assert.throws(() => decodeKaiPlatformLegal({
    ...legalResponse,
    documents: {
      ...legalResponse.documents,
      terms: { ...legalResponse.documents.terms, url: 'http://cloudpay.kai.com/legal/terms' },
    },
  }), KaiPlatformResponseError);
  assert.throws(() => decodeKaiPlatformLegal({
    ...legalResponse,
    documents: {
      ...legalResponse.documents,
      privacy: { ...legalResponse.documents.privacy, current: true },
    },
  }), KaiPlatformResponseError);
  assert.throws(() => decodeKaiPlatformLegal({
    ...legalResponse,
    documents: {
      ...legalResponse.documents,
      inquiry: { ...legalResponse.documents.inquiry, url: 'not-a-url' },
    },
  }), KaiPlatformResponseError);
});

test('consent response must match the documents the user actually accepted', () => {
  const documents = decodeKaiPlatformLegal(legalResponse);
  assert.throws(() => decodeKaiPlatformConsent({
    ok: true,
    accepted: { termsVersion: 'old', privacyVersion: documents.privacy.version },
    replayed: false,
  }, documents), KaiPlatformResponseError);
  assert.throws(() => decodeKaiPlatformConsent({
    ok: true,
    accepted: { termsVersion: documents.terms.version, privacyVersion: documents.privacy.version },
    replayed: false,
    session: { authenticated: true },
  }, documents), KaiPlatformResponseError);
});
