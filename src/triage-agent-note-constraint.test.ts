import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schema = JSON.parse(readFileSync(new URL('../agent/superops-triage-html-note-constraint.json', import.meta.url), 'utf8'));
const constraint = schema.constraints[0];
const notePattern = new RegExp(constraint.constraint.items.properties.note.pattern);
const labels = ['Ticket goal', 'What needs to be known', 'Next step', 'When'];
const makeNote = (separator: string, bodies = ['Review the synthetic network request.', 'The synthetic requester reports a connection issue.', 'An engineer should investigate.', 'During the next support review.']) =>
  '<strong>TRIAGE SUMMARY</strong><br><br>' + labels.map((label, index) => '<strong>' + label + ':</strong>' + separator + bodies[index]).join('<br><br>');

describe('published Agent HTML note constraint', () => {
  it('accepts inline content and content after an HTML break without changing required labels', () => {
    expect(notePattern.test(makeNote(' '))).toBe(true);
    expect(notePattern.test(makeNote('<br>'))).toBe(true);
    expect(notePattern.test(makeNote('<br />\n'))).toBe(true);
  });

  it('rejects an empty section rather than borrowing content from the next label', () => {
    for (let index = 0; index < labels.length; index++) {
      const bodies = ['Goal.', 'Evidence.', 'Review.', 'Next support review.'];
      bodies[index] = '';
      expect(notePattern.test(makeNote('<br>', bodies))).toBe(false);
      bodies[index] = ' \n<br>\t';
      expect(notePattern.test(makeNote(' ', bodies))).toBe(false);
    }
  });

  it('preserves supported optional historical sections and rejects missing or reordered required sections', () => {
    const note = makeNote(' ');
    expect(notePattern.test(note.replace('<br><br><strong>Next step:', '<br><br><strong>Historical solution:</strong><br>Verified advisory solution.<br><br><strong>Next step:'))).toBe(true);
    expect(notePattern.test(note.replace('<strong>Ticket goal:</strong> Review the synthetic network request.<br><br>', ''))).toBe(false);
    expect(notePattern.test(note.replace('Ticket goal:', 'Issue summary:'))).toBe(false);
    expect(notePattern.test(note.replace('What needs to be known:', 'Next step:'))).toBe(false);
  });

  it('keeps the constraint on triage actions and private notes', () => {
    expect(constraint.action_name).toBe('superops_tickets_apply_triage_plan');
    expect(constraint.parameter).toBe('actions');
    expect(constraint.constraint.items.properties.isPublicNote).toEqual({ const: false });
  });
});
