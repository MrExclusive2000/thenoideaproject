import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, tokens, scoreFaq, matchFaq } from '../src/faq/matcher.js';

const FAQS = [
  { id: 1, question: 'How do I install the app on my Firestick?', answer: 'a', keywords: 'install, firestick, downloader, setup', priority: 0, enabled: 1 },
  { id: 2, question: 'The app keeps buffering, what can I do?', answer: 'b', keywords: 'buffering, freeze, stuck, loading, lag', priority: 0, enabled: 1 },
  { id: 3, question: 'How do I renew my subscription?', answer: 'c', keywords: 'renew, payment, expired, subscription', priority: 0, enabled: 1 },
  { id: 4, question: 'What devices are supported?', answer: 'd', keywords: 'devices, android, ios, firestick, tv', priority: 0, enabled: 1 },
];

test('normalize strips punctuation and case', () => {
  assert.equal(normalize("My FIRE-stick's app!!"), 'my fire sticks app');
});

test('tokens removes stopwords', () => {
  assert.deepEqual(tokens('How do I install the app?'), ['install', 'app']);
});

test('exact question matches with high score', () => {
  const { match, score } = matchFaq('How do I install the app on my Firestick?', FAQS, 0.5);
  assert.equal(match.id, 1);
  assert.ok(score > 0.8);
});

test('rephrased question still matches via keywords', () => {
  const { match } = matchFaq('guys my firestick wont install it, help', FAQS, 0.45);
  assert.equal(match?.id, 1);
});

test('typo survives via trigram similarity', () => {
  const { match } = matchFaq('app keeps bufering all the time', FAQS, 0.4);
  assert.equal(match?.id, 2);
});

test('unrelated question does not match', () => {
  const { match } = matchFaq('what is the weather in London today', FAQS, 0.5);
  assert.equal(match, null);
});

test('empty and junk input do not crash or match', () => {
  assert.equal(matchFaq('', FAQS, 0.5).match, null);
  assert.equal(matchFaq('???!!!', FAQS, 0.5).match, null);
  assert.equal(matchFaq('a', FAQS, 0.5).match, null);
});

test('disabled FAQs are skipped', () => {
  const disabled = FAQS.map((f) => ({ ...f, enabled: 0 }));
  assert.equal(matchFaq('how to install on firestick', disabled, 0.4).match, null);
});

test('no anchor overlap means zero score even when trigrams are similar', () => {
  const { score } = scoreFaq('completely different topic entirely', FAQS[0]);
  assert.equal(score, 0);
});

test('near miss is reported for admin inbox context', () => {
  const result = matchFaq('why does it buffer', FAQS, 0.9);
  assert.equal(result.match, null);
  assert.ok(result.nearMiss === null || result.nearMiss.id === 2);
});
