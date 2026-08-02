import assert from 'node:assert';
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as promptInput from '../src/prompt-input.ts';
import { resolveAgentPrompt } from '../src/prompt-input.ts';
import type { AgentPrompt } from '../src/types.ts';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
const WEBP_BYTES = Buffer.from('RIFF0000WEBPdata');

async function promptFixture(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), 'switchboard-prompt-input-'));
  const cwd = join(root, 'worktree');
  await mkdir(join(cwd, 'uploads'), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, cwd };
}

test('resolveAgentPrompt classifies a real PNG inside the worktree', async (t) => {
  const fixture = await promptFixture(t);
  await writeFile(join(fixture.cwd, 'uploads', 'screen.png'), PNG_BYTES);

  const prompt = await resolveAgentPrompt(
    fixture.cwd, 'Inspect this screenshot', ['uploads/screen.png'],
  );

  assert.deepEqual(prompt.attachments[0], {
    name: 'screen.png', relativePath: 'uploads/screen.png',
    absolutePath: await realpath(join(fixture.cwd, 'uploads', 'screen.png')), kind: 'image',
  });
});

test('resolveAgentPrompt returns a canonical path through an internal symlinked parent', async (t) => {
  const fixture = await promptFixture(t);
  const realUploads = join(fixture.cwd, 'real-uploads');
  await mkdir(realUploads);
  await writeFile(join(realUploads, 'screen.png'), PNG_BYTES);
  await symlink(realUploads, join(fixture.cwd, 'linked-uploads'));

  const prompt = await resolveAgentPrompt(
    fixture.cwd, 'Inspect this screenshot', ['linked-uploads/screen.png'],
  );

  assert.equal(prompt.attachments[0].absolutePath, await realpath(join(realUploads, 'screen.png')));
  assert.doesNotMatch(prompt.attachments[0].absolutePath, /linked-uploads/);
});

test('resolveAgentPrompt recognizes exact JPEG and WebP signatures', async (t) => {
  const fixture = await promptFixture(t);
  await Promise.all([
    writeFile(join(fixture.cwd, 'uploads', 'photo.jpeg'), JPEG_BYTES),
    writeFile(join(fixture.cwd, 'uploads', 'diagram.webp'), WEBP_BYTES),
  ]);

  const prompt = await resolveAgentPrompt(fixture.cwd, '', [
    'uploads/photo.jpeg', 'uploads/diagram.webp',
  ]);

  assert.deepEqual(prompt.attachments.map(({ name, kind }) => ({ name, kind })), [
    { name: 'photo.jpeg', kind: 'image' },
    { name: 'diagram.webp', kind: 'image' },
  ]);
});

test('resolveAgentPrompt keeps ordinary files as files', async (t) => {
  const fixture = await promptFixture(t);
  await writeFile(join(fixture.cwd, 'notes.txt'), 'plain text');

  const prompt = await resolveAgentPrompt(fixture.cwd, 'Read this', ['notes.txt']);

  assert.equal(prompt.attachments[0].kind, 'file');
});

test('resolveAgentPrompt accepts an omitted attachment list as empty', async (t) => {
  const fixture = await promptFixture(t);
  assert.deepEqual(await resolveAgentPrompt(fixture.cwd, 'No files', undefined), {
    text: 'No files', attachments: [],
  });
});

for (const [label, value] of [
  ['non-array input', 'uploads/a.txt'],
  ['non-string entries', ['uploads/a.txt', 3]],
] as const) {
  test(`resolveAgentPrompt rejects ${label}`, async (t) => {
    const fixture = await promptFixture(t);
    await assert.rejects(
      resolveAgentPrompt(fixture.cwd, 'x', value),
      { message: label === 'non-array input'
        ? 'Attachments must be an array.'
        : 'Attachment paths must be strings.' },
    );
  });
}

test('resolveAgentPrompt rejects more than ten attachments', async (t) => {
  const fixture = await promptFixture(t);
  await assert.rejects(
    resolveAgentPrompt(fixture.cwd, 'x', Array.from({ length: 11 }, (_, i) => `file-${i}`)),
    { message: 'At most 10 attachments are allowed.' },
  );
});

test('resolveAgentPrompt rejects duplicate paths', async (t) => {
  const fixture = await promptFixture(t);
  await writeFile(join(fixture.cwd, 'same.txt'), 'same');
  await assert.rejects(
    resolveAgentPrompt(fixture.cwd, 'x', ['./same.txt', 'same.txt']),
    { message: 'Attachment paths must be unique.' },
  );
});

for (const [label, path] of [
  ['absolute paths', '/tmp/outside.txt'],
  ['parent traversal', '../outside.txt'],
  ['nested parent traversal', 'uploads/../outside.txt'],
] as const) {
  test(`resolveAgentPrompt rejects ${label}`, async (t) => {
    const fixture = await promptFixture(t);
    await assert.rejects(resolveAgentPrompt(fixture.cwd, 'x', [path]), {
      message: 'Attachment paths must stay inside the worktree.',
    });
  });
}

test('resolveAgentPrompt rejects a missing file without exposing its path', async (t) => {
  const fixture = await promptFixture(t);
  const missing = 'uploads/private-customer-name.txt';
  await assert.rejects(resolveAgentPrompt(fixture.cwd, 'x', [missing]), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'Attachment 1 does not exist.');
    assert.doesNotMatch(error.message, /private-customer-name/);
    return true;
  });
});

test('resolveAgentPrompt rejects a submitted symlink', async (t) => {
  const fixture = await promptFixture(t);
  await writeFile(join(fixture.cwd, 'real.txt'), 'real');
  await symlink('../real.txt', join(fixture.cwd, 'uploads', 'link.txt'));
  await assert.rejects(resolveAgentPrompt(fixture.cwd, 'x', ['uploads/link.txt']), {
    message: 'Attachment 1 must be a regular file, not a symbolic link.',
  });
});

test('resolveAgentPrompt rejects escape through a symlinked parent', async (t) => {
  const fixture = await promptFixture(t);
  const outside = join(fixture.root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'secret');
  await symlink(outside, join(fixture.cwd, 'escape'));

  await assert.rejects(resolveAgentPrompt(fixture.cwd, 'x', ['escape/secret.txt']), {
    message: 'Attachment paths must stay inside the worktree.',
  });
});

test('revalidateAgentPrompt rejects a leaf swapped to a symlink after resolution', async (t) => {
  const fixture = await promptFixture(t);
  const submitted = join(fixture.cwd, 'uploads', 'notes.txt');
  const outside = join(fixture.root, 'outside.txt');
  await Promise.all([writeFile(submitted, 'inside'), writeFile(outside, 'outside')]);
  const prompt = await resolveAgentPrompt(fixture.cwd, 'Read it', ['uploads/notes.txt']);
  await rm(submitted);
  await symlink(outside, submitted);
  const revalidate = (promptInput as {
    revalidateAgentPrompt?: (cwd: string, prompt: AgentPrompt) => Promise<AgentPrompt>;
  }).revalidateAgentPrompt;

  assert.ok(revalidate, 'revalidation must happen immediately before adapter delivery');
  await assert.rejects(revalidate(fixture.cwd, prompt), {
    message: 'Attachment 1 must be a regular file, not a symbolic link.',
  });
});

test('revalidateAgentPrompt rejects a parent swapped outside after resolution', async (t) => {
  const fixture = await promptFixture(t);
  const parent = join(fixture.cwd, 'pending');
  const outside = join(fixture.root, 'outside');
  await Promise.all([mkdir(parent), mkdir(outside)]);
  await Promise.all([
    writeFile(join(parent, 'notes.txt'), 'inside'),
    writeFile(join(outside, 'notes.txt'), 'outside'),
  ]);
  const prompt = await resolveAgentPrompt(fixture.cwd, 'Read it', ['pending/notes.txt']);
  await rm(parent, { recursive: true });
  await symlink(outside, parent);
  const revalidate = (promptInput as {
    revalidateAgentPrompt?: (cwd: string, prompt: AgentPrompt) => Promise<AgentPrompt>;
  }).revalidateAgentPrompt;

  assert.ok(revalidate, 'revalidation must happen immediately before adapter delivery');
  await assert.rejects(revalidate(fixture.cwd, prompt), {
    message: 'Attachment paths must stay inside the worktree.',
  });
});

test('resolveAgentPrompt rejects directories', async (t) => {
  const fixture = await promptFixture(t);
  await assert.rejects(resolveAgentPrompt(fixture.cwd, 'x', ['uploads']), {
    message: 'Attachment 1 must be a regular file.',
  });
});

test('resolveAgentPrompt wraps unreadable image failures without exposing the path', async (t) => {
  const fixture = await promptFixture(t);
  const path = join(fixture.cwd, 'uploads', 'customer-secret.png');
  await writeFile(path, PNG_BYTES);
  await chmod(path, 0o000);

  await assert.rejects(resolveAgentPrompt(fixture.cwd, 'x', ['uploads/customer-secret.png']),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'Attachment 1 could not be read.');
      assert.doesNotMatch(error.message, /customer-secret|switchboard-prompt-input/);
      return true;
    });
});

for (const [name, bytes] of [
  ['wrong.png', JPEG_BYTES],
  ['wrong.jpg', PNG_BYTES],
  ['wrong.webp', Buffer.from('RIFF0000NOPEdata')],
] as const) {
  test(`resolveAgentPrompt rejects extension/signature mismatch for ${name}`, async (t) => {
    const fixture = await promptFixture(t);
    await writeFile(join(fixture.cwd, name), bytes);
    await assert.rejects(resolveAgentPrompt(fixture.cwd, 'x', [name]), {
      message: 'Attachment 1 has invalid image contents.',
    });
  });
}
