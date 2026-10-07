import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../lib/buyers.mjs';
test('lead generation describes an offer, not leadership seniority', () => {
  assert.equal(classify('Lead Generation').offer, 'B');
  assert.equal(classify('Lead Generation Specialist').score, 13);
  assert.equal(classify('Lead Generation Manager'), null);
  assert.equal(classify('Data Entry Specialist').offer, 'ops');
  assert.equal(classify('Knowledge Base Specialist').offer, 'A');
  assert.equal(classify('Software Engineer'), null);
});
