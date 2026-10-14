import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from 'obsidian-test-mocks/obsidian';
import TaskQueryUndoPlugin from '../src/main';
import { bindPro, isPro, resetPro, SPONSORS, PRO_UI, onProChange } from '../src/pro';
import { bytes, detect, FILE_LIMIT, FOLDER_LIMIT, HISTORY_BYTES, loadHistory, restoreText, trimHistory, type Change } from '../src/engine';
import { normalizeSettings } from '../src/settings';
import manifest from '../manifest.json';

afterEach(() => resetPro());
const before = '# Bills\n- [ ] Pay rent\nRent details\n\nJournal';
const after = before.replace('[ ]', '[x]');

function fixture(contents: Record<string, string> = { 'Tasks/Rent.md': before }) {
 const app = App.createConfigured__({ files: contents });
 const plugin = new TaskQueryUndoPlugin(app as never, manifest as never);
 const data = new Map(Object.entries(contents));
 const local = new Map<string, unknown>();
 const files = Object.keys(contents).map(path => app.vault.getFileByPath(path)!);
 for (const file of files) Object.assign(file, { stat: { size: bytes(data.get(file.path)!), ctime: 10, mtime: 10 } });
 Object.assign(app.vault, {
  getMarkdownFiles: () => files,
  getFileByPath: (path: string) => files.find(f => f.path === path) ?? null,
  cachedRead: vi.fn(async (file: { path: string }) => data.get(file.path)!),
  read: vi.fn(async (file: { path: string }) => data.get(file.path)!),
  process: vi.fn(async (file: { path: string }, fn: (text: string) => string) => {
   const next = fn(data.get(file.path)!);
   data.set(file.path, next);
   return next;
  }),
 });
 Object.assign(app, { loadLocalStorage: vi.fn((key: string) => local.get(key)), saveLocalStorage: vi.fn((key: string, value: unknown) => local.set(key, value)) });
 vi.spyOn(plugin, 'saveData').mockResolvedValue(undefined);
 plugin.settings.folder = 'Tasks';
 return { app, plugin, files, data, local, file: files[0]! };
}
function pro(value: boolean): void { bindPro({ isPro: () => value, onChange: () => () => undefined } as never); }

async function completion(f: ReturnType<typeof fixture>): Promise<void> {
 await f.plugin.scan();
 f.data.set(f.file.path, after);
 await f.plugin.observe(f.file as never);
}

describe('Vault history and atomic recovery', () => {
 it('starts without a folder and does not record baseline contents', async () => {
  const f = fixture();
  f.plugin.settings.folder = '';
  await f.plugin.scan();
  expect(f.plugin.ready).toBe(false);
  expect(f.plugin.history).toEqual([]);
  f.plugin.settings.folder = 'Tasks';
  await f.plugin.scan();
  expect(f.plugin.ready).toBe(true);
  expect(f.plugin.history).toEqual([]);
 });
 it('records a completion and restores through Vault.process while keeping a later paragraph', async () => {
  const f = fixture();
  await completion(f);
  expect(f.plugin.history).toHaveLength(1);
  f.data.set(f.file.path, after + '\n\nA later paragraph.');
  await f.plugin.observe(f.file as never);
  const result = await f.plugin.restore(f.plugin.history[0]!.id);
  expect(result).toContain('restored');
  expect(f.data.get(f.file.path)).toBe(before + '\n\nA later paragraph.');
  expect(f.app.vault.process).toHaveBeenCalledOnce();
  expect(f.plugin.history).toEqual([]);
  await f.plugin.observe(f.file as never);
  expect(f.plugin.history).toEqual([]);
 });
 it('refuses stale content inside the atomic callback without writing text', async () => {
  const f = fixture(); await completion(f);
  f.data.set(f.file.path, after.replace('Pay rent', 'Pay May rent'));
  const old = f.data.get(f.file.path);
  expect(await f.plugin.restore(f.plugin.history[0]!.id)).toContain('refused');
  expect(f.data.get(f.file.path)).toBe(old);
  expect(f.plugin.history).toHaveLength(1);
 });
 it('refuses ambiguous context without writing text', async () => {
  const f = fixture(); await completion(f);
  f.data.set(f.file.path, after + '\n' + after);
  const old = f.data.get(f.file.path);
  expect(await f.plugin.restore(f.plugin.history[0]!.id)).toContain('more than one');
  expect(f.data.get(f.file.path)).toBe(old);
 });
 it('refuses a concurrent task edit at the process boundary', async () => {
  const f = fixture(); await completion(f);
  vi.mocked(f.app.vault.process).mockImplementationOnce(async (file, fn) => {
   f.data.set(file.path, after.replace('Pay rent', 'Pay June rent'));
   const next = fn(f.data.get(file.path)!);
   f.data.set(file.path, next); return next;
  });
  expect(await f.plugin.restore(f.plugin.history[0]!.id)).toContain('refused');
  expect(f.data.get(f.file.path)).toContain('June');
 });
 it('skips a combined update but uses it as the next baseline', async () => {
  const f = fixture(); await f.plugin.scan();
  f.data.set(f.file.path, after.replace('Journal', 'New journal'));
  await f.plugin.observe(f.file as never);
  expect(f.plugin.history).toEqual([]);
  f.data.set(f.file.path, before.replace('Journal', 'New journal'));
  await f.plugin.observe(f.file as never);
  f.data.set(f.file.path, after.replace('Journal', 'New journal'));
  await f.plugin.observe(f.file as never);
  expect(f.plugin.history).toHaveLength(1);
 });
 it('keeps ten free records after eleven completions and starts empty on reload', async () => {
  const f = fixture(); await f.plugin.scan();
  for (let i = 0; i < 11; i++) {
   f.data.set(f.file.path, before); await f.plugin.observe(f.file as never);
   f.data.set(f.file.path, after); await f.plugin.observe(f.file as never);
  }
  expect(f.plugin.history).toHaveLength(10);
  expect(f.app.saveLocalStorage).not.toHaveBeenCalled();
  const reloaded = new TaskQueryUndoPlugin(f.app as never, manifest as never);
  expect(reloaded.history).toEqual([]);
 });
 it('does not read notes outside the selected folder', async () => {
  const f = fixture({ 'Other/A.md': before, 'Tasks-extra/B.md': before, 'Tasks/A.md': before });
  await f.plugin.scan();
  expect([...f.plugin.baseline.keys()]).toEqual(['Tasks/A.md']);
  expect(f.app.vault.cachedRead).toHaveBeenCalledTimes(1);
 });
 it('lists notes above the file limit without reading them', async () => {
  const f = fixture(); f.file.stat.size = FILE_LIMIT + 1;
  await f.plugin.scan();
  expect(f.app.vault.cachedRead).not.toHaveBeenCalled();
  expect(f.plugin.baseline.size).toBe(0);
  expect(f.plugin.skipped.get(f.file.path)).toContain('1 MiB');
 });
 it('caps the selected folder at twenty MiB', async () => {
  const f = fixture(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`Tasks/${i}.md`, 'a'.repeat(FILE_LIMIT)])));
  await f.plugin.scan();
  expect(f.plugin.baseline.size).toBe(20);
  expect(f.plugin.skipped.size).toBe(1);
  expect([...f.plugin.baseline.values()].reduce((n, text) => n + bytes(text), 0)).toBe(FOLDER_LIMIT);
 });
 it('drops the baseline if a note grows above one MiB', async () => {
  const f = fixture(); await f.plugin.scan();
  f.data.set(f.file.path, 'a'.repeat(FILE_LIMIT + 1));
  await f.plugin.observe(f.file as never);
  expect(f.plugin.baseline.size).toBe(0);
  expect(f.plugin.skipped.size).toBe(1);
 });
 it('drops a failed read and requires a new scan', async () => {
  const f = fixture(); await f.plugin.scan();
  vi.mocked(f.app.vault.read).mockRejectedValueOnce(new Error('Read error'));
  await f.plugin.observe(f.file as never);
  expect(f.plugin.baseline.size).toBe(0);
  expect(f.plugin.skipped.get(f.file.path)).toContain('Read failed');
 });
 it('reports a failed write and retains the record', async () => {
  const f = fixture(); await completion(f);
  vi.mocked(f.app.vault.process).mockRejectedValueOnce(new Error('Disk full'));
  expect(await f.plugin.restore(f.plugin.history[0]!.id)).toContain('could not be written');
  expect(f.plugin.history).toHaveLength(1);
  expect(f.data.get(f.file.path)).toBe(after);
 });
 it('refuses an expired record or a record outside the selected folder', async () => {
  const f = fixture(); await completion(f);
  expect(await f.plugin.restore('missing')).toContain('no longer');
  f.plugin.settings.folder = 'Other';
  expect(await f.plugin.restore(f.plugin.history[0]!.id)).toContain('select the folder');
 });
 it('does not track a newly created file until the next scan', async () => {
  const f = fixture(); f.plugin.ready = true;
  await f.plugin.observe(f.file as never);
  expect(f.app.vault.read).not.toHaveBeenCalled();
 });
});

describe('Pro history and profiles', () => {
 it('stores Pro history on this device and accepts it on reload', async () => {
  const f = fixture(); pro(true); await completion(f);
  const stored = f.local.get('task-query-undo-history');
  expect(loadHistory(stored)).toEqual(f.plugin.history);
  expect(f.app.saveLocalStorage).toHaveBeenCalledWith('task-query-undo-history', f.plugin.history);
 });
 it('blocks saving and applying folder profiles without Pro', async () => {
  const f = fixture();
  expect(await f.plugin.saveProfile('Home')).toBe(false);
  f.plugin.settings.profiles = [{ name: 'Home', folder: 'Other', filter: 'rent' }];
  expect(await f.plugin.useProfile('Home')).toBe(false);
  expect(f.plugin.settings.folder).toBe('Tasks');
 });
 it('saves and applies a folder with its history filter when Pro is active', async () => {
  const f = fixture(); pro(true);
  f.plugin.settings.filter = 'rent';
  expect(await f.plugin.saveProfile('Home')).toBe(true);
  f.plugin.settings.filter = '';
  expect(await f.plugin.useProfile('Home')).toBe(true);
  expect(f.plugin.settings.filter).toBe('rent');
  expect(f.plugin.baseline.size).toBe(1);
 });
 it('clears local history without changing the note', async () => {
  const f = fixture(); pro(true); await completion(f);
  await f.plugin.clearHistory();
  expect(f.plugin.history).toEqual([]);
  expect(f.local.get('task-query-undo-history')).toEqual([]);
  expect(f.data.get(f.file.path)).toBe(after);
 });
 it('keeps the ten free records even when their total size exceeds the Pro disk cap', () => {
  const old = '- [ ] ' + 'a'.repeat(FILE_LIMIT - 6);
  const change: Change = { ...detect(old, old.replace('[ ]', '[x]'))!, id: '1', path: 'Tasks/A.md', folder: 'Tasks', time: 1000 };
  expect(trimHistory(Array.from({ length: 11 }, () => change), false)).toHaveLength(10);
 });
 it('keeps the current recovery record if local history storage fails', async () => {
  const f = fixture(); pro(true);
  vi.mocked(f.app.saveLocalStorage).mockImplementation(() => { throw new Error('Quota exceeded'); });
  await completion(f);
  expect(f.plugin.history).toHaveLength(1);
  expect(f.plugin.baseline.size).toBe(1);
  expect(f.plugin.status).toContain('could not be saved');
  expect(await f.plugin.restore(f.plugin.history[0]!.id)).toContain('restored');
  expect(f.data.get(f.file.path)).toBe(before);
 });
 it('limits Pro history to one hundred records', () => {
  const change = { ...detect(before, after)!, id: '1', path: 'Tasks/A.md', folder: 'Tasks', time: 1000 };
  expect(trimHistory(Array.from({ length: 101 }, () => change), true)).toHaveLength(100);
 });
 it('limits persisted history by bytes', () => {
  const change: Change = { ...detect(before, after)!, id: '1', path: 'Tasks/A.md', folder: 'Tasks', time: 1000, previous: 'a'.repeat(FILE_LIMIT) };
  const result = trimHistory(Array.from({ length: 30 }, () => change), true);
  expect(bytes(JSON.stringify(result))).toBeLessThanOrEqual(HISTORY_BYTES);
  expect(result.length).toBeLessThan(30);
 });
 it('normalizes saved folder paths, drops invalid profiles, and caps filters', () => {
  expect(normalizeSettings({ folder: '//Tasks//Home/', filter: 'x'.repeat(300), profiles: [null, { name: 'Home', folder: '//Tasks/', filter: '' }] })).toEqual({ folder: 'Tasks/Home', filter: 'x'.repeat(200), profiles: [{ name: 'Home', folder: 'Tasks', filter: '' }] });
 });
 it('refuses a stored task moved into code', () => {
  const change = { ...detect(before, after)!, id: '1', path: 'Tasks/A.md', folder: 'Tasks', time: 1000 };
  expect(() => restoreText('```\n' + after + '\n```', change)).toThrow('no longer an eligible');
 });
});

describe('GitHub Sponsors facade', () => {
 it('uses the reference client and prices', () => {
  expect(SPONSORS).toEqual({ clientId: 'Ov23lic5UPGPZqhBlBGg', sponsorLogin: 'theluckystrike', minMonthlyUsd: 5, oneTimeUsd: 15, oneTimeMonths: 0, scope: 'read:user' });
  expect(PRO_UI.priceText).toBe('Sponsor $5 a month, or $15 once. When you have paid $15 in total, Pro stays on.');
 });
 it('uses the cached state and removes listeners on unload', () => {
  let enabled = false; let changed = () => undefined;
  const off = vi.fn();
  bindPro({ isPro: () => enabled, onChange: (fn: () => void) => { changed = fn; return off; } } as never);
  const listener = vi.fn(); onProChange(listener);
  expect(isPro()).toBe(false); enabled = true; changed();
  expect(isPro()).toBe(true); expect(listener).toHaveBeenCalledOnce();
  resetPro(); expect(isPro()).toBe(false); expect(off).toHaveBeenCalledOnce();
 });
});


describe('Review regressions', () => {
 it('uses the atomic result even if a later read would fail', async () => {
  const f = fixture(); await completion(f);
  vi.mocked(f.app.vault.read).mockRejectedValueOnce(new Error('Read failed after write'));
  expect(await f.plugin.restore(f.plugin.history[0]!.id)).toContain('restored');
  expect(f.data.get(f.file.path)).toBe(before);
  expect(f.plugin.history).toEqual([]);
  expect(f.plugin.baseline.get(f.file.path)).toBe(before);
 });
 it('observes a new completion after an atomic restore', async () => {
  const f = fixture(); await completion(f);
  vi.mocked(f.app.vault.process).mockImplementationOnce(async (file, fn) => {
   const saved = fn(f.data.get(file.path)!);
   f.data.set(file.path, saved.replace('[ ]', '[x]'));
   return saved;
  });
  expect(await f.plugin.restore(f.plugin.history[0]!.id)).toContain('restored');
  await f.plugin.observe(f.file as never);
  expect(f.plugin.history).toHaveLength(1);
 });
 it('does not write a queued restore after unload', async () => {
  const f = fixture(); await completion(f);
  const result = f.plugin.restore(f.plugin.history[0]!.id);
  f.plugin.onunload();
  expect(await result).toContain('refused');
  expect(f.app.vault.process).not.toHaveBeenCalled();
  expect(f.data.get(f.file.path)).toBe(after);
 });
 it('does not track a note moved during a read until a new scan', async () => {
  const f = fixture(); await f.plugin.scan();
  vi.mocked(f.app.vault.read).mockImplementationOnce(async file => {
   const text = after;
   file.path = 'Tasks/Moved.md';
   f.data.set(file.path, text);
   return text;
  });
  await f.plugin.observe(f.file as never);
  expect(f.plugin.history).toEqual([]);
  expect(f.plugin.baseline.has('Tasks/Moved.md')).toBe(false);
 });
 it('clears free history if device storage is unavailable', async () => {
  const f = fixture(); await completion(f);
  vi.mocked(f.app.saveLocalStorage).mockImplementation(() => { throw new Error('Storage unavailable'); });
  await expect(f.plugin.clearHistory()).resolves.toBeUndefined();
  expect(f.plugin.history).toEqual([]);
  expect(f.plugin.status).toContain('cannot clear');
  expect(f.data.get(f.file.path)).toBe(after);
 });
});


describe('Review async boundaries', () => {
 it('refuses an atomic callback that starts after unload', async () => {
  const f = fixture(); await completion(f);
  vi.mocked(f.app.vault.process).mockImplementationOnce(async (file, fn) => {
   f.plugin.onunload();
   const saved = fn(f.data.get(file.path)!);
   f.data.set(file.path, saved); return saved;
  });
  expect(await f.plugin.restore(f.plugin.history[0]!.id)).toContain('refused');
  expect(f.data.get(f.file.path)).toBe(after);
 });
 it('refuses a note moved before the atomic callback', async () => {
  const f = fixture(); await completion(f);
  vi.mocked(f.app.vault.process).mockImplementationOnce(async (file, fn) => {
   file.path = 'Tasks/Moved.md'; f.data.set(file.path, after);
   const saved = fn(f.data.get(file.path)!);
   f.data.set(file.path, saved); return saved;
  });
  expect(await f.plugin.restore(f.plugin.history[0]!.id)).toContain('moved or deleted');
  expect(f.data.get(f.file.path)).toBe(after);
 });
 it('does not baseline a note moved during a scan', async () => {
  const f = fixture();
  vi.mocked(f.app.vault.cachedRead).mockImplementationOnce(async file => {
   file.path = 'Tasks/Moved.md'; f.data.set(file.path, before); return before;
  });
  await f.plugin.scan();
  expect(f.plugin.baseline.has('Tasks/Moved.md')).toBe(false);
 });
 it('does not overwrite unread Pro history when local storage fails', async () => {
  const f = fixture(); pro(true);
  vi.mocked(f.app.loadLocalStorage).mockImplementation(() => { throw new Error('History read unavailable'); });
  const load = Reflect.get(f.plugin, 'loadLocalHistory') as () => void; load.call(f.plugin);
  await completion(f);
  expect(f.plugin.history).toHaveLength(1);
  expect(f.app.saveLocalStorage).not.toHaveBeenCalled();
  expect(f.plugin.status).toContain('could not be read');
 });
 it('loads saved Pro history after a transient storage read failure', async () => {
  const f = fixture(); pro(true);
  const saved: Change = { ...detect(before, after)!, id: 'saved', path: f.file.path, folder: 'Tasks', time: 1000 };
  f.local.set('task-query-undo-history', [saved]);
  vi.mocked(f.app.loadLocalStorage).mockImplementationOnce(() => { throw new Error('History read unavailable'); });
  const load = Reflect.get(f.plugin, 'loadLocalHistory') as () => void; load.call(f.plugin);
  await f.plugin.scan();
  f.data.set(f.file.path, after); await f.plugin.observe(f.file as never);
  expect(f.plugin.history.map(c => c.id)).toContain('saved');
  expect(f.plugin.history).toHaveLength(2);
 });
});


describe('Review file replacement', () => {
 it('refuses a record for an older file at the same path', async () => {
  const f = fixture(); await completion(f);
  f.files[0] = { ...f.file, stat: { ...f.file.stat, ctime: f.file.stat.ctime + 1 } } as never;
  expect(await f.plugin.restore(f.plugin.history[0]!.id)).toContain('creation time');
  expect(f.app.vault.process).not.toHaveBeenCalled();
  expect(f.data.get(f.file.path)).toBe(after);
 });
});


describe('Review Pro state changes', () => {
 it('recovers the longer saved history after sign out and sign in in one session', async () => {
  const f = fixture();
  vi.spyOn(f.plugin, 'addSettingTab').mockImplementation(() => undefined);
  Object.assign(f.app.workspace, { onLayoutReady: vi.fn() });
  await f.plugin.onload();
  f.plugin.settings.folder = 'Tasks';
  const manager = f.plugin.pro!;
  manager.opts.http = async () => ({ status: 200, json: { data: { viewer: { login: 'reader' }, user: { sponsorshipForViewerAsSponsor: { isActive: true, tier: { monthlyPriceInCents: 500 } } } } } });
  manager.opts.tokens.set('gho_' + '0'.repeat(36));
  await manager.refreshNow();
  await f.plugin.scan();
  for (let i = 0; i < 11; i++) {
   f.data.set(f.file.path, before); await f.plugin.observe(f.file as never);
   f.data.set(f.file.path, after); await f.plugin.observe(f.file as never);
  }
  expect(f.plugin.history).toHaveLength(11);
  manager.signOut();
  expect(f.plugin.history).toHaveLength(10);
  manager.opts.tokens.set('gho_' + '0'.repeat(36));
  await manager.refreshNow();
  expect(f.plugin.history).toHaveLength(11);
  expect(new Set(f.plugin.history.map(c => c.id)).size).toBe(11);
  f.plugin.onunload();
 });
});


describe('Review clear with unread Pro history', () => {
 it('keeps the session empty when clearing saved history fails before the first load', async () => {
  const f = fixture(); pro(true);
  f.local.set('task-query-undo-history', [{ ...detect(before, after)!, id: 'saved', path: f.file.path, folder: 'Tasks', time: 1000, fileCreatedAt: 10 }]);
  vi.mocked(f.app.saveLocalStorage).mockImplementation(() => { throw new Error('Storage unavailable'); });
  await expect(f.plugin.clearHistory()).resolves.toBeUndefined();
  expect(f.plugin.history).toEqual([]);
  expect(f.data.get(f.file.path)).toBe(before);
 });
});
