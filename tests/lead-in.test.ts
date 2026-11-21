import { describe, expect, it } from 'vitest';
import { isLeadIn, leadTitle } from '@/features/timeline/lead-in';

describe('isLeadIn', () => {
  it('knows the one-line announcements agents write before a step', () => {
    for (const t of [
      'Let me read the error handler and the admin routes.',
      "I'll start by finding every place that writes an error body by hand.",
      'Now let me run the tests.',
      'Perfect. Let me run the type check.',
      "Now I'll make the admin guard throw `HttpError` like the middleware does.",
      'Let me check the tests:',
      'I’m going to scan the repo for error handlers.',
      "I'm checking the routes first.",
      'Checking the webhook path next.',
      'Good, now let me look at `routes.ts`.',
      'Lass mich die Tests ausführen.',
      'I need to check the config first.',
      'Looking good, let me run the tests.',
      // What an agent in the middle of the work says it does next.
      'Running the tests now.',
      'Committing.',
      'Good. Re-running the suite.',
      "I'm updating the tests now.",
      'Going to check the phone build.',
      // A move to the next thing with no verb in it.
      'Now the CSS.',
      'Next, the tests.',
      'Good. Now the two dialogs.',
      'On to the phone build.',
      // A nod that says nothing the work line does not.
      'Done. Let me run the tests.',
      'That works. Now the docs.',
      'Makes sense. Let me read the handler.',
    ])
      expect(isLeadIn(t, false), t).toBe(true);
  });

  it('keeps reports, answers and questions in view', () => {
    for (const t of [
      "Found it: the admin guard answers `{ message: 'Forbidden' }`. Let me check the routes.",
      'The admin guard now answers like the rest, and the suite passes.',
      'Done. Tests and the type check pass.',
      'Let me know if you want the webhooks changed too.',
      'Should I also change the webhooks?',
      "I'm seeing two failures in the auth tests.",
      'Let me read the handler.\n\nThen the routes.',
      `Let me ${'read every file in the project '.repeat(8)}`,
      'Now the guard throws like everywhere else.',
      // Openers that lead into something the agent says, not something it does next.
      'I should note the key is read from .env.',
      'I need to point out that the tests were already failing.',
      'Let me also mention that the cache is per process.',
      'Looking at the logs, the guard throws before the handler runs.',
      // The owner's own example of a progress note: what is done, then what comes next.
      'The account order is committed on the side branch. Now checking how a chat shows when only its sub-agents still run.',
      'Tests pass. Now the type check.',
      'Committed. Now the docs.',
      // A move with a verb in it is a statement.
      'Now the tests pass.',
      'Now the build works again.',
      'First the store, then the middleware.',
      // A doing word in front of what happened.
      'Running the tests showed two failures.',
      'Fixing the import fixed the build.',
    ])
      expect(isLeadIn(t, false), t).toBe(false);
  });

  it('holds a text being written that may still become one, and lets it go once it plainly is not', () => {
    expect(isLeadIn('', true)).toBe(true);
    expect(isLeadIn('Le', true)).toBe(true);
    expect(isLeadIn('Now', true)).toBe(true);
    expect(isLeadIn('Now let me ru', true)).toBe(true);
    expect(isLeadIn('Perfect. Let', true)).toBe(true);
    expect(isLeadIn('The admin', true)).toBe(false);
    // "Now the" may still end as "Now the CSS.": held until a verb or a sixth word says otherwise.
    expect(isLeadIn('Now the guard', true)).toBe(true);
    expect(isLeadIn('Now the guard throws', true)).toBe(false);
    expect(isLeadIn('Now the admin guard in the middleware file', true)).toBe(false);
    expect(isLeadIn('That wo', true)).toBe(true);
    expect(isLeadIn('Let me run the tests. They', true)).toBe(false);
    // Finished, a fragment is just a fragment.
    expect(isLeadIn('Now', false)).toBe(false);
  });
});

describe('leadTitle', () => {
  it('names what the step does, in the voice of a step title', () => {
    expect(leadTitle('Now let me run the tests.')).toBe('Run the tests');
    expect(leadTitle("I'll start by finding every place that writes an error body by hand.")).toBe('Finding every place that writes an error body by hand');
    expect(leadTitle('Perfect. Let me run the type check.')).toBe('Run the type check');
    expect(leadTitle("I'm checking the routes first.")).toBe('Checking the routes first');
    expect(leadTitle('Checking the webhook path next.')).toBe('Checking the webhook path next');
    expect(leadTitle('Let me check `routes.ts`:')).toBe('Check routes.ts');
    expect(leadTitle('Lass mich die Tests ausführen.')).toBe('Die Tests ausführen');
    expect(leadTitle('Now the CSS.')).toBe('The CSS');
    expect(leadTitle('Good. Next, the tests.')).toBe('The tests');
    expect(leadTitle('Running the tests now.')).toBe('Running the tests now');
    expect(leadTitle('That works. Now the docs.')).toBe('The docs');
  });
});
