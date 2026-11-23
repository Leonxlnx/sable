/**
 * Messages Claude Code writes in the person's place (shared/synthetic.ts): every shape it knows,
 * cut and odd ones, and the person's own messages it must leave alone.
 */
import { describe, expect, it } from 'vitest';
import {
  lostTasksNote,
  RESUME_AFTER_RESET,
  parseSynthetic,
  partLine,
  readableTitle,
  stripWrappers,
  syntheticLine,
  syntheticOf,
  taskLabel,
  userText,
  type Synthetic,
  type SyntheticPart,
  type TaskNote,
} from '@shared/synthetic';

const BUILD = `<task-notification>
<task-id>b296xlpn0</task-id>
<tool-use-id>toolu_013ENjGFRmDF6eTN74ukivtv</tool-use-id>
<output-file>C:\\Users\\me\\AppData\\Local\\Temp\\claude\\tasks\\b296xlpn0.output</output-file>
<status>completed</status>
<summary>Background command "Build the installer" completed (exit code 0)</summary>
</task-notification>`;

const AGENT = `<task-notification>
<task-id>a71c2</task-id>
<tool-use-id>toolu_01AbC</tool-use-id>
<status>completed</status>
<summary>Agent "Review the auth flow" completed</summary>
<result>Two findings:

1. **Login** is rate limited per address, not per account.
2. Session expiry lives in one place now.</result>
<usage>total_tokens: 48210
tool_uses: 17
duration_ms: 124500</usage>
</task-notification>`;

const task = (s: Synthetic | null, i = 0): TaskNote => {
  const p = s?.parts.filter((x): x is Extract<SyntheticPart, { kind: 'task' }> => x.kind === 'task')[i];
  if (!p) throw new Error('no task');
  return p.task;
};

describe('task notifications', () => {
  it('reads a background command that finished', () => {
    const s = parseSynthetic(BUILD);
    expect(s?.role).toBe('notification');
    const t = task(s);
    expect(t).toMatchObject({
      id: 'b296xlpn0',
      toolUseId: 'toolu_013ENjGFRmDF6eTN74ukivtv',
      kind: 'command',
      status: 'completed',
      outcome: 'done',
      name: 'Build the installer',
      exitCode: 0,
      outputFile: 'C:\\Users\\me\\AppData\\Local\\Temp\\claude\\tasks\\b296xlpn0.output',
    });
    expect(taskLabel(t)).toBe('Background task finished');
    expect(syntheticLine(s!)).toBe('Background task finished: Build the installer');
  });

  it('reads an agent with its result and usage', () => {
    const t = task(parseSynthetic(AGENT));
    expect(t.kind).toBe('agent');
    expect(t.outcome).toBe('done');
    expect(t.name).toBe('Review the auth flow');
    expect(t.result).toContain('1. **Login** is rate limited');
    expect(t.result?.startsWith('Two findings:')).toBe(true);
    expect(t.usage).toEqual({ tokens: 48210, toolUses: 17, durationMs: 124500 });
    expect(taskLabel(t)).toBe('Agent finished');
  });

  it('reads usage written as elements too', () => {
    const t = task(parseSynthetic('<task-notification><status>completed</status><summary>Agent "x" completed</summary><usage><total_tokens>12</total_tokens><tool_uses>3</tool_uses><duration_ms>900</duration_ms></usage></task-notification>'));
    expect(t.usage).toEqual({ tokens: 12, toolUses: 3, durationMs: 900 });
  });

  it('knows failed, stopped and running', () => {
    const failed = task(parseSynthetic('<task-notification><status>failed</status><summary>Background command "npm test" failed with exit code 1</summary></task-notification>'));
    expect(failed.outcome).toBe('failed');
    expect(failed.exitCode).toBe(1);
    expect(taskLabel(failed)).toBe('Background task failed');
    // Completed with a nonzero exit code still reads as failed.
    expect(task(parseSynthetic('<task-notification><status>completed</status><summary>Background command "lint" completed (exit code 2)</summary></task-notification>')).outcome).toBe('failed');
    const killed = task(parseSynthetic('<task-notification><status>killed</status><summary>Background command "dev server" was stopped</summary></task-notification>'));
    expect(killed.outcome).toBe('stopped');
    expect(taskLabel(killed)).toBe('Background task stopped');
    const agentFailed = task(parseSynthetic('<task-notification><status>failed</status><summary>Agent "Port the parser" failed: out of context</summary></task-notification>'));
    expect(taskLabel(agentFailed)).toBe('Agent failed');
    const monitor = task(parseSynthetic('<task-notification><task-type>monitor</task-type><status>running</status><summary>Monitor event: "deploy log"</summary></task-notification>'));
    expect(monitor.kind).toBe('monitor');
    expect(taskLabel(monitor)).toBe('Monitor event');
  });

  it('reads the outcome from the summary when the status is missing', () => {
    expect(task(parseSynthetic('<task-notification><summary>Background command "x" completed (exit code 0)</summary></task-notification>')).outcome).toBe('done');
    expect(task(parseSynthetic('<task-notification><summary>Something else</summary></task-notification>')).outcome).toBe('unknown');
    expect(taskLabel(task(parseSynthetic('<task-notification><summary>Something else</summary></task-notification>')))).toBe('Background task');
  });

  it('takes the task type when given', () => {
    expect(task(parseSynthetic('<task-notification><task-type>local_agent</task-type><status>completed</status><summary>done</summary></task-notification>')).kind).toBe('agent');
    expect(task(parseSynthetic('<task-notification><task-type>local_bash</task-type><status>completed</status><summary>done</summary></task-notification>')).kind).toBe('command');
  });

  it('tolerates odd whitespace, CRLF, tabs and attributes', () => {
    const odd = `\r\n  \t<task-notification  run="r1" >\r\n\t<task-id>  b1 </task-id>\r\n<status>  Completed \r\n</status>\r\n<summary>\r\n  Background command   “Build”\r\n  completed (exit code 0)  </summary>\r\n</task-notification>\r\n\r\n`;
    const t = task(parseSynthetic(odd));
    expect(t.id).toBe('b1');
    expect(t.status).toBe('completed');
    expect(t.outcome).toBe('done');
    expect(t.name).toBe('Build');
    expect(t.summary).toBe('Background command “Build” completed (exit code 0)');
  });

  it('reads one cut short (no closing tags)', () => {
    const cut = AGENT.slice(0, AGENT.indexOf('2. Session'));
    const s = parseSynthetic(cut);
    expect(s?.role).toBe('notification');
    const t = task(s);
    expect(t.name).toBe('Review the auth flow');
    expect(t.result).toContain('1. **Login**');
    expect(t.usage).toBeUndefined();
    // Cut right after the opening tag: still a notification, with nothing more known.
    const bare = parseSynthetic('<task-notification>');
    expect(bare?.role).toBe('notification');
    expect(syntheticLine(bare!)).toBe('Background task');
    expect(syntheticLine(parseSynthetic('<task-notification>\n<task-id>b29')!)).toBe('Background task');
  });

  it('keeps a trailer and takes the output file from it', () => {
    const s = parseSynthetic('<task-notification><status>completed</status><summary>Background command "x" completed (exit code 0)</summary></task-notification>\nRead the output file to retrieve the result: /tmp/tasks/x.output');
    expect(s?.role).toBe('notification');
    expect(s?.extra).toMatch(/^Read the output file/);
    expect(task(s).outputFile).toBe('/tmp/tasks/x.output');
  });

  it('reads several in one message', () => {
    const s = parseSynthetic(`${BUILD}\n${AGENT}`);
    expect(s?.parts.filter((p) => p.kind === 'task')).toHaveLength(2);
    expect(task(s, 1).name).toBe('Review the auth flow');
    expect(syntheticLine(s!)).toBe('Background task finished: Build the installer and 1 more');
  });

  it('keeps a result that mentions the closing tag whole', () => {
    const t = task(parseSynthetic('<task-notification><status>completed</status><summary>Agent "x" completed</summary><result>Use </result> to close it.</result></task-notification>'));
    expect(t.result).toBe('Use </result> to close it.');
  });
});

describe('commands', () => {
  it('reads a slash command in any order', () => {
    const a = parseSynthetic('<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>opus</command-args>');
    expect(a?.role).toBe('command');
    expect(a?.parts).toEqual([{ kind: 'command', name: '/model', args: 'opus' }]);
    expect(syntheticLine(a!)).toBe('/model opus');
    const b = parseSynthetic('<command-message>review is running…</command-message>\n<command-name>/review</command-name>\n<command-args>PR 12</command-args>');
    expect(syntheticLine(b!)).toBe('/review PR 12');
  });

  it('names the command from its message when the name is missing', () => {
    expect(syntheticLine(parseSynthetic('<command-message>model</command-message>')!)).toBe('/model');
    expect(syntheticLine(parseSynthetic('<command-message>review is running…</command-message>')!)).toBe('/review');
    expect(syntheticLine(parseSynthetic('<command-name>compact</command-name><command-args></command-args>')!)).toBe('/compact');
  });

  it('reads what a command printed, without terminal colours', () => {
    const s = parseSynthetic('<local-command-stdout>Set model to \u001b[1mOpus 5.5\u001b[22m</local-command-stdout>');
    expect(s?.role).toBe('output');
    expect(s?.parts).toEqual([{ kind: 'output', text: 'Set model to Opus 5.5', error: false, source: 'command' }]);
    expect(syntheticLine(s!)).toBe('Set model to Opus 5.5');
    const err = parseSynthetic('<local-command-stderr>Unknown model: opux</local-command-stderr>');
    expect(err?.parts[0]).toMatchObject({ kind: 'output', error: true });
    // Nothing printed: nothing to show.
    expect(parseSynthetic('<local-command-stdout></local-command-stdout>')?.role).toBe('hidden');
    expect(parseSynthetic('<local-command-stdout>  \n </local-command-stdout>')?.role).toBe('hidden');
  });

  it('reads a command and its output in one message', () => {
    const s = parseSynthetic('<command-name>/cost</command-name><command-args></command-args><local-command-stdout>Total cost: $0.42\nTotal duration: 3m</local-command-stdout>');
    expect(s?.role).toBe('command');
    expect(s?.parts.map((p) => p.kind)).toEqual(['command', 'output']);
  });

  it('reads a ! command with its output and exit code', () => {
    const input = parseSynthetic('<bash-input>ls -la</bash-input>');
    expect(input?.role).toBe('command');
    expect(syntheticLine(input!)).toBe('! ls -la');
    const out = parseSynthetic('<bash-stdout>a.txt\nb.txt</bash-stdout><bash-stderr></bash-stderr>');
    expect(out?.role).toBe('output');
    expect(out?.parts[0]).toEqual({ kind: 'output', text: 'a.txt\nb.txt', error: false, source: 'bash' });
    const failed = parseSynthetic('<bash-stdout>x</bash-stdout><bash-stderr>boom</bash-stderr><bash-exit-code>2</bash-exit-code>');
    expect(failed?.parts.filter((p) => p.kind === 'output')).toHaveLength(2);
  });
});

describe('what stays hidden', () => {
  it('hides caveats, reminders and markers', () => {
    expect(parseSynthetic('<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>')?.role).toBe('hidden');
    expect(parseSynthetic('Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages.')?.role).toBe('hidden');
    expect(parseSynthetic('<system-reminder>\nThe task list is empty.\n</system-reminder>')?.role).toBe('hidden');
    expect(parseSynthetic('[Request interrupted by user]')?.role).toBe('hidden');
    expect(parseSynthetic('[Request interrupted by user for tool use]')?.role).toBe('hidden');
    expect(syntheticLine(parseSynthetic('<system-reminder>x</system-reminder>')!)).toBe('');
  });

  it('a notification keeps its reminders out of sight', () => {
    const s = parseSynthetic(`${BUILD}\n<system-reminder>Remember the plan.</system-reminder>`);
    expect(s?.role).toBe('notification');
    expect(s?.parts.map((p) => p.kind)).toEqual(['task', 'hidden']);
  });
});

describe('messages from elsewhere and summaries', () => {
  it('reads a teammate or another session', () => {
    const s = parseSynthetic('<teammate-message teammate_id="researcher" color="blue">Found the bug in session.ts</teammate-message>');
    expect(s?.role).toBe('notification');
    expect(s?.parts[0]).toEqual({ kind: 'message', from: 'researcher', text: 'Found the bug in session.ts' });
    expect(syntheticLine(s!)).toBe('Message from researcher: Found the bug in session.ts');
    expect(syntheticLine(parseSynthetic("<cross-session-message from='local_123'>hi</cross-session-message>")!)).toBe('Message from local_123: hi');
  });

  it('reads the summary a compacted conversation continues from', () => {
    const s = parseSynthetic('This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.\n\nAnalysis: ...');
    expect(s?.role).toBe('summary');
    expect(syntheticLine(s!)).toBe('Conversation summary');
  });
});

describe("the person's own messages", () => {
  it('leaves plain and unknown ones alone', () => {
    for (const text of ['Fix the login bug', '<div>hello</div> is broken', '<3 thanks', '[link](https://x.dev) is down', '[x] done', '  <br/> tag', 'Caveat: this is mine', '<commandname>x</commandname>', '']) {
      expect(parseSynthetic(text)).toBeNull();
      expect(userText(text)).toBe(text);
    }
  });

  it('a message with a reminder added is still theirs, shown without it', () => {
    const text = 'Run the tests please\n<system-reminder>The user opened src/a.ts</system-reminder>';
    expect(parseSynthetic(text)).toBeNull();
    expect(stripWrappers(text)).toBe('Run the tests please');
    expect(userText(text)).toBe('Run the tests please');
    expect(parseSynthetic('<system-reminder>context</system-reminder>\nAnd now fix it')).toBeNull();
    expect(userText('<system-reminder>context</system-reminder>\nAnd now fix it')).toBe('And now fix it');
  });

  it('a message that only mentions a tag in prose is theirs', () => {
    const text = 'Why does Claude show <task-notification> in my chat?';
    expect(parseSynthetic(text)).toBeNull();
    // Starting with a tag that never closes, with words of their own after it.
    expect(parseSynthetic('<task-notification> is what I see in my chat, why?')).toBeNull();
    expect(parseSynthetic('<system-reminder> what does this tag do?')).toBeNull();
    expect(parseSynthetic('<teammate-message> how do I send one')).toBeNull();
  });
});

describe('titles and items', () => {
  it('turns an XML title into words', () => {
    expect(readableTitle('<task-notification>')).toBe('Background task');
    expect(readableTitle('<command-name>/model</command-name>')).toBe('/model');
    expect(readableTitle('<command-message>model</command-message>')).toBe('/model');
    expect(readableTitle('<local-command-stdout>Set model to Opus 5.5</local-command-stdout>')).toBe('Set model to Opus 5.5');
    expect(readableTitle('<local-command-caveat>Caveat: The messages below were generated…')).toBe('');
    expect(readableTitle('[Request interrupted by user]')).toBe('');
    expect(readableTitle('Fix the login bug')).toBe('Fix the login bug');
    expect(readableTitle('Why <div> breaks')).toBe('Why <div> breaks');
  });

  it('reads an item once', () => {
    const item = { type: 'user', text: BUILD };
    const a = syntheticOf(item);
    expect(a?.role).toBe('notification');
    expect(syntheticOf(item)).toBe(a);
    expect(syntheticOf({ type: 'text', text: BUILD })).toBeNull();
    expect(syntheticOf({ type: 'user', text: 'hello' })).toBeNull();
  });

  it('says each part as one line', () => {
    expect(partLine({ kind: 'bash', command: 'git status' })).toBe('! git status');
    expect(partLine({ kind: 'message', from: '', text: '\n\nhello\nthere' })).toBe('Message from another session: hello');
  });
});

describe('the note of tasks lost with their process', () => {
  const note = lostTasksNote([`"Run app tests" (command, task b1x2)`, `"Watch logs" (monitor, task m1)`]);

  it('names every task and never says they ended', () => {
    expect(note).toContain('"Run app tests" (command, task b1x2); "Watch logs" (monitor, task m1)');
    expect(note).toContain('may still be running');
    expect(note).toContain('no notification will come for them');
    expect(lostTasksNote([])).toBe('');
  });

  it("is never shown as the person's words: after their message, before a wrapper or the Browser tab's line", () => {
    expect(userText(`Continue${note}`)).toBe('Continue');
    expect(stripWrappers(`Continue${note}`)).toBe('Continue');
    expect(userText(`Fix the login page${note}

<system-reminder>Answer this message first.</system-reminder>`)).toBe('Fix the login page');
    expect(userText(`Fix it${note}

[Sable: the user's Browser tab shows http://localhost:5173/. browser_read reads it.]`)).toBe('Fix it');
    expect(parseSynthetic(`Continue${note}`)).toBeNull();
  });

  it("a carry-on with the note is all Sable's", () => {
    expect(parseSynthetic(`${RESUME_AFTER_RESET}${note}`)).toMatchObject({ role: 'hidden' });
  });

  it('the same words inside what the person wrote stay theirs', () => {
    const pasted = `Why did Sable say this?${note}

It keeps happening.`;
    expect(userText(pasted)).toBe(pasted);
  });
});
