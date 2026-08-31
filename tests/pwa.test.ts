import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstallModel, installAddress, installGuides, installPlatform } from '../src/pwa.ts';
import type { InstallChoice, InstallWork, NativeInstallPrompt } from '../src/pwa.ts';

const idle: InstallWork = { busy: false, filesSelected: false, temporaryResults: false };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function native(choice: InstallChoice | Promise<InstallChoice> = { outcome: 'accepted' }) {
  const calls = { prevented: 0, prompted: 0 };
  const event: NativeInstallPrompt = {
    preventDefault() { calls.prevented++; },
    prompt() { calls.prompted++; return Promise.resolve(choice); },
  };
  return { event, calls };
}

test('an unsupported or not-yet-eligible browser has a usable manual-install button', async () => {
  const model = new InstallModel();
  assert.deepEqual(model.button(idle), { label: '설치 방법', hidden: false, disabled: false });
  assert.equal(await model.request(idle), 'manual');
});

test('capturing eligibility never automatically prompts, even while videos could be running', () => {
  const model = new InstallModel();
  const prompt = native(); model.capture(prompt.event);
  assert.equal(prompt.calls.prevented, 1); assert.equal(prompt.calls.prompted, 0);
  assert.equal(model.button(idle).label, '앱 설치');
  assert.equal(model.button({ ...idle, busy: true }).disabled, true);
});

test('native prompt runs synchronously and locks double clicks until the choice resolves', async () => {
  const choice = deferred<InstallChoice>();
  const prompt = native(choice.promise); const model = new InstallModel();
  model.capture(prompt.event);
  const task = model.request(idle);
  assert.equal(prompt.calls.prompted, 1, 'must prompt before returning the first promise');
  assert.equal(model.prompting, true);
  assert.equal(model.button(idle).disabled, true);
  assert.equal(await model.request(idle), 'busy');
  choice.resolve({ outcome: 'accepted' });
  assert.equal(await task, 'accepted');
  assert.equal(prompt.calls.prompted, 1);
  assert.equal(model.prompting, false);
});

test('acceptance is not installation; hide only on confirmed appinstalled', async () => {
  const model = new InstallModel(); model.capture(native().event);
  assert.equal(await model.request(idle), 'accepted');
  assert.deepEqual(model.button(idle), { label: '설치 확인', hidden: false, disabled: false });
  model.markInstalled();
  assert.equal(model.button(idle).hidden, true);
  assert.equal(model.snapshot.accepted, false);
  assert.equal(await model.request(idle), 'installed');
});

test('installed state is session-only and does not carry into a newly opened page', () => {
  const first = new InstallModel(); first.markInstalled();
  assert.equal(first.button(idle).hidden, true);
  assert.equal(new InstallModel().button(idle).hidden, false);
});

test('video work blocks installation without consuming the deferred event', async () => {
  const prompt = native(); const model = new InstallModel(); model.capture(prompt.event);
  assert.equal(await model.request({ ...idle, busy: true }), 'busy');
  assert.equal(prompt.calls.prompted, 0);
  assert.equal(model.snapshot.nativeAvailable, true);
  assert.equal(await model.request(idle), 'accepted');
});

test('selected originals and temporary results each require explicit acknowledgment', async () => {
  for (const work of [{ ...idle, filesSelected: true }, { ...idle, temporaryResults: true }]) {
    const model = new InstallModel(); const prompt = native(); model.capture(prompt.event);
    assert.equal(await model.request(work), 'confirm');
    assert.equal(prompt.calls.prompted, 0);
    assert.equal(model.snapshot.nativeAvailable, true);
    assert.equal(await model.request(work, true), 'accepted');
  }
});

test('manual-install help also requires acknowledgment of selected work', async () => {
  const model = new InstallModel(); const work = { ...idle, temporaryResults: true };
  assert.equal(await model.request(work), 'confirm');
  assert.equal(await model.request(work, true), 'manual');
});

test('work is checked again after confirmation instead of trusting an earlier idle snapshot', async () => {
  const model = new InstallModel(); const prompt = native(); model.capture(prompt.event);
  assert.equal(await model.request({ ...idle, filesSelected: true }), 'confirm');
  assert.equal(await model.request({ ...idle, busy: true, filesSelected: true }, true), 'busy');
  assert.equal(prompt.calls.prompted, 0);
});

test('dismissal consumes the event and exposes manual help; a new event can be used', async () => {
  const model = new InstallModel(); const prompt = native({ outcome: 'dismissed' }); model.capture(prompt.event);
  assert.equal(await model.request(idle), 'dismissed');
  assert.equal(await model.request(idle), 'manual');
  assert.equal(model.button(idle).label, '설치 방법');
  assert.equal(prompt.calls.prompted, 1);
  model.capture(native().event);
  assert.equal(await model.request(idle), 'accepted');
});

test('prompt rejection and synchronous errors restore work controls and manual help', async () => {
  for (const run of [() => Promise.reject(new Error('not supported')), () => { throw new Error('not allowed'); }]) {
    const model = new InstallModel(); model.capture({ preventDefault() {}, prompt: run });
    assert.equal(await model.request(idle), 'failed');
    assert.equal(model.button(idle).disabled, false);
    assert.equal(await model.request(idle), 'manual');
  }
});

test('legacy browsers can return the choice through userChoice', async () => {
  const model = new InstallModel();
  const choice = deferred<InstallChoice>();
  model.capture({ preventDefault() {}, async prompt() {}, userChoice: choice.promise });
  const task = model.request(idle);
  assert.equal(model.prompting, true);
  choice.resolve({ outcome: 'dismissed' });
  assert.equal(await task, 'dismissed');
  assert.equal(model.prompting, false);
});

test('a prompt with no choice result does not claim installed or accepted', async () => {
  const model = new InstallModel(); model.capture({ preventDefault() {}, async prompt() {} });
  assert.equal(await model.request(idle), 'requested');
  assert.equal(model.snapshot.hidden, false); assert.equal(model.snapshot.accepted, false);
});

test('standalone display hides installation and discards stale native events', async () => {
  const model = new InstallModel(); const first = native(); model.capture(first.event);
  model.setStandalone(true);
  assert.equal(model.snapshot.nativeAvailable, false);
  assert.equal(model.button(idle).hidden, true);
  const late = native(); model.capture(late.event);
  assert.equal(late.calls.prevented, 1);
  assert.equal(await model.request(idle), 'installed');
  model.setStandalone(false);
  assert.equal(await model.request(idle), 'manual');
  assert.equal(first.calls.prompted + late.calls.prompted, 0);
});

test('an appinstalled event during an open prompt cannot be undone by a late acceptance', async () => {
  const choice = deferred<InstallChoice>(); const model = new InstallModel(); model.capture(native(choice.promise).event);
  const task = model.request(idle); model.markInstalled();
  choice.resolve({ outcome: 'accepted' }); await task;
  assert.equal(model.snapshot.hidden, true);
  assert.equal(model.snapshot.accepted, false);
  assert.equal(model.prompting, false);
});

test('a fresh eligibility event is not lost when an older prompt completes', async () => {
  const choice = deferred<InstallChoice>(); const model = new InstallModel(); model.capture(native(choice.promise).event);
  const task = model.request(idle);
  const next = native(); model.capture(next.event);
  choice.resolve({ outcome: 'accepted' }); await task;
  assert.equal(model.snapshot.nativeAvailable, true);
  assert.equal(model.snapshot.accepted, false);
  assert.equal(await model.request(idle), 'accepted');
  assert.equal(next.calls.prompted, 1);
});

test('callbacks expose both sides of the prompt lock and never change the supplied work', async () => {
  const observed: boolean[] = [];
  const model = new InstallModel(() => { observed.push(model.prompting); });
  model.capture(native().event);
  const work = Object.freeze({ ...idle, temporaryResults: true });
  await model.request(work, true);
  assert.deepEqual(observed, [false, true, false]);
  assert.deepEqual(work, { busy: false, filesSelected: false, temporaryResults: true });
});

test('platform detection is used for instructions and covers iPad desktop-mode user agents', () => {
  assert.equal(installPlatform('Mozilla/5.0 (iPhone) CriOS/140'), 'ios');
  assert.equal(installPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X)', 5), 'ios');
  assert.equal(installPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X)', 0), 'mac');
  assert.equal(installPlatform('Mozilla/5.0 (Linux; Android 13) SamsungBrowser/26.0'), 'samsung');
  assert.equal(installPlatform('Mozilla/5.0 (Linux; Android 13) Chrome/140'), 'android');
  assert.equal(installPlatform('Mozilla/5.0 (Windows NT 10.0) Chrome/140'), 'desktop');
  assert.equal(installPlatform(''), 'desktop');
  for (const guide of Object.values(installGuides)) { assert.equal(guide.steps.length, 3); assert.ok(guide.steps.every(step => step.length > 10)); }
});

test('copyable install address keeps the Pages subpath but strips queries and fragments', () => {
  assert.equal(installAddress('https://smrmdkqo-afk.github.io/video-splitter/?source=chat#work'), 'https://smrmdkqo-afk.github.io/video-splitter/');
  assert.equal(installAddress('https://example.com/video-splitter/index.html?key=unused', '/video-splitter/'), 'https://example.com/video-splitter/');
  assert.equal(installAddress('http://localhost:5173/?test=yes#hello'), 'http://localhost:5173/');
});
