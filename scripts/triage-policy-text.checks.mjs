import assert from 'node:assert/strict';
import {test} from 'node:test';
import {normalizeBuilderPolicy, normalizePolicyParagraphs} from './triage-policy-text.mjs';

const canonical = 'Policy contract version: 2026-10-04.1\nsuperops_tickets_prepare_triage_plan\n<strong>TRIAGE SUMMARY</strong><br><br>\nOn every superops_* call\nDo not retry apply after ANY response\n';
const exported = canonical.replace(/([_<*])/g, '\\$1').replace(/\n/g, '\r\n\r\n');

test('accepts the observed Builder Markdown escapes and paragraph serialization', () => {
  assert.equal(normalizeBuilderPolicy(exported), normalizePolicyParagraphs(canonical));
});

test('rejects policy, tool and HTML changes despite presentation normalization', () => {
  for (const [before, after] of [['2026-10-04.1', '2026-09-15.1'], ['prepare', 'apply'], ['strong', 'em'], ['Do not retry', 'Retry']]) {
    assert.notEqual(normalizeBuilderPolicy(exported.replace(before, after)), normalizePolicyParagraphs(canonical));
  }
});

test('preserves line boundaries, inline spacing and unrecognized escapes', () => {
  for (const changed of [canonical.replace('\nsuperops', ' superops'), canonical.replace('every superops', 'every  superops'), canonical + '\\!']) {
    assert.notEqual(normalizeBuilderPolicy(changed), normalizePolicyParagraphs(canonical));
  }
});
