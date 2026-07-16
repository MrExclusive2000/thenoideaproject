import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-seed-'));

const { db, now } = await import('../src/db/db.js');
const { seedStarterContent, addStarterFaqs, STARTER_FAQS } = await import('../src/db/seed.js');
const { matchFaq } = await import('../src/faq/matcher.js');

after(() => {
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test('first boot seeds starter FAQs and hidden starter guides', () => {
  seedStarterContent();
  const faqCount = db.prepare('SELECT COUNT(*) n FROM faqs').get().n;
  assert.equal(faqCount, STARTER_FAQS.length);
  const guides = db.prepare('SELECT * FROM guides').all();
  assert.ok(guides.length >= 2);
  assert.ok(guides.every((g) => g.visible === 0), 'starter guides ship hidden (contain placeholders)');
});

test('seeding is idempotent — second boot adds nothing', () => {
  seedStarterContent();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM faqs').get().n, STARTER_FAQS.length);
});

test('starter pack skips questions that already exist', () => {
  db.prepare('DELETE FROM faqs').run();
  db.prepare('INSERT INTO faqs (question, answer, keywords, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(STARTER_FAQS[0].question.toUpperCase(), 'custom answer', '', now(), now());
  const added = addStarterFaqs();
  assert.equal(added, STARTER_FAQS.length - 1, 'existing question (case-insensitive) not duplicated');
  assert.equal(addStarterFaqs(), 0, 'nothing left to add');
});

test('starter FAQs actually match how people ask', () => {
  db.prepare('DELETE FROM faqs').run();
  addStarterFaqs();
  const faqs = db.prepare('SELECT * FROM faqs').all();
  const cases = [
    ['guys how do i instal this on my fire stick??', 'Firestick'],
    ['its constantly bufering and freezing on movies', 'buffering'],
    ['can you add the new season of severance pls', 'VOD'],
    ['how do i renew my sub', 'subscription'],
  ];
  for (const [q, expect] of cases) {
    const { match } = matchFaq(q, faqs, 0.5);
    assert.ok(match, `no match for: ${q}`);
    assert.ok(
      match.question.toLowerCase().includes(expect.toLowerCase()) ||
      match.answer.toLowerCase().includes(expect.toLowerCase()),
      `"${q}" matched wrong FAQ: ${match.question}`
    );
  }
});
