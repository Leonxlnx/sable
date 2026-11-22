/**
 * Review wave 8, finding 13: a manual run of the macOS workflow from another branch with a release
 * tag must not replace that release's downloads with that branch's build. The tag's commit is
 * resolved first, built exactly, and checked again (commit and version) before the upload. A static
 * check of `.github/workflows/mac.yml` (no runner here).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const yml = readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'mac.yml'), 'utf8').replace(/\r\n/g, '\n');
const job = (name: string) => {
  const start = yml.indexOf(`\n  ${name}:\n`);
  expect(start).toBeGreaterThan(0);
  const next = yml.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? yml.slice(start) : yml.slice(start, start + 1 + next);
};

describe('the macOS workflow builds and uploads only the tag it names', () => {
  it('resolves the tag to its commit before anything is built', () => {
    const target = job('target');
    expect(target).toContain('gh api "repos/$GH_REPO/commits/refs/tags/$TAG"');
    expect(target).toContain('inputs.tag');
    // A tag of the release form only.
    expect(target).toMatch(/\^v\[0-9\]\+/);
  });

  it('checks out that commit, not the branch the run started from, and refuses another version', () => {
    const mac = job('mac');
    expect(mac).toContain('needs: target');
    expect(mac).toMatch(/ref: \$\{\{ needs\.target\.outputs\.sha \}\}/);
    expect(mac).toContain('[ "$(git rev-parse HEAD)" = "$SHA" ]');
    expect(mac).toContain('"v$VERSION" != "$TAG"');
  });

  it('uploads only when the tag still points at the built commit and every file carries its version', () => {
    const attach = job('attach');
    expect(attach).toContain('needs: [target, mac]');
    expect(attach).toContain("if: needs.target.outputs.tag != ''");
    expect(attach).not.toContain('inputs.tag');
    const check = attach.indexOf('[ "$NOW" = "$SHA" ]');
    const version = attach.indexOf('is not of version');
    const upload = attach.indexOf('gh release upload');
    expect(check).toBeGreaterThan(0);
    expect(version).toBeGreaterThan(check);
    expect(upload).toBeGreaterThan(version);
  });
});
