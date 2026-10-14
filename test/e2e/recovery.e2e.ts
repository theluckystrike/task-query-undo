import { browser, expect } from '@wdio/globals';
import type TaskQueryUndoPlugin from '../../src/main';
import { pluginId, reloadPlugin } from './load';

const path = 'Tasks/Rent.md';
const initial = '# Bills\n- [ ] Pay rent\nRent details\n\nJournal\n';

async function reset(): Promise<void> {
 await browser.executeObsidian(async ({ app }, id, p, text) => {
  const plugin = (app as unknown as { plugins: { plugins: Record<string, TaskQueryUndoPlugin> } }).plugins.plugins[id]!;
  plugin.pro!.signOut();
  for (const modal of [...plugin.modals]) modal.close();
  await plugin.flush();
  await app.vault.modify(app.vault.getFileByPath(p)!, text);
  await plugin.clearHistory();
  await plugin.selectFolder('Tasks');
 }, pluginId, path, initial);
}
async function write(text: string): Promise<void> {
 await browser.executeObsidian(async ({ app }, id, p, value) => {
  const plugin = (app as unknown as { plugins: { plugins: Record<string, TaskQueryUndoPlugin> } }).plugins.plugins[id]!;
  await app.vault.modify(app.vault.getFileByPath(p)!, value);
  // This barrier drains the registered modify handler. No clock or theme is used.
  await plugin.flush();
 }, pluginId, path, text);
}
async function state(): Promise<{ count: number; ready: boolean; text: string; records: { before: string; after: string }[] }> {
 return browser.executeObsidian(async ({ app }, id, p) => {
  const plugin = (app as unknown as { plugins: { plugins: Record<string, TaskQueryUndoPlugin> } }).plugins.plugins[id]!;
  await plugin.flush();
  return { count: plugin.history.length, ready: plugin.ready, text: await app.vault.read(app.vault.getFileByPath(p)!), records: plugin.history.map(c => ({ before: c.before, after: c.after })) };
 }, pluginId, path);
}
async function restore(): Promise<string> {
 return browser.executeObsidian(async ({ app }, id) => {
  const plugin = (app as unknown as { plugins: { plugins: Record<string, TaskQueryUndoPlugin> } }).plugins.plugins[id]!;
  await plugin.flush();
  return plugin.restore(plugin.history[0]!.id);
 }, pluginId);
}
async function setPro(): Promise<void> {
 await browser.executeObsidian(async ({ app }, id) => {
  const plugin = (app as unknown as { plugins: { plugins: Record<string, TaskQueryUndoPlugin> } }).plugins.plugins[id]!;
  const manager = plugin.pro! as unknown as { opts: { http: unknown }; refreshNow(): Promise<unknown> };
  manager.opts.http = async () => ({ status: 200, json: { data: { viewer: { login: 'demo-reader' }, user: { sponsorshipForViewerAsSponsor: { isActive: true, isOneTimePayment: false, tier: { name: '$5 a month', monthlyPriceInCents: 500 } } } } } });
  app.secretStorage.setSecret(`${id}-github-token`, 'gho_' + '0'.repeat(36));
  await manager.refreshNow();
 }, pluginId);
}

describe('Task line recovery in Obsidian', function () {
 beforeEach(async () => reset());
 afterEach(async () => {
  await browser.executeObsidian(({ app }, id) => {
   const plugin = (app as unknown as { plugins: { plugins: Record<string, TaskQueryUndoPlugin> } }).plugins.plugins[id]!;
   plugin.pro!.signOut();
   for (const modal of [...plugin.modals]) modal.close();
  }, pluginId);
 });
 it('records a real modify event and shows Before and After in the modal', async () => {
  expect((await state()).ready).toBe(true);
  expect((await state()).count).toBe(0);
  await write(initial.replace('[ ]', '[x]'));
  expect((await state()).records).toEqual([{ before: '- [ ] Pay rent', after: '- [x] Pay rent' }]);
  await browser.executeObsidianCommand(`${pluginId}:show-history`);
  await expect(browser.$('.tqu-before')).toHaveText('- [ ] Pay rent');
  await expect(browser.$('.tqu-after')).toHaveText('- [x] Pay rent');
 });
 it('restores through the button and keeps a later paragraph', async () => {
  await write(initial.replace('[ ]', '[x]'));
  await write(initial.replace('[ ]', '[x]') + '\nLater paragraph.\n');
  await browser.executeObsidianCommand(`${pluginId}:show-history`);
  const button = browser.$('.tqu-record').$('button=Restore line');
  await button.scrollIntoView({ block: 'center' });
  await button.waitForClickable(); await button.click();
  await browser.waitUntil(async () => (await state()).count === 0, { timeout: 10000, timeoutMsg: 'Restore did not remove the record' });
  expect((await state()).text).toBe(initial + '\nLater paragraph.\n');
  await expect(browser.$('.tqu-result')).toHaveText('Task line restored. Other lines are kept.');
 });
 it('removes a done date from the same saved update', async () => {
  await write(initial.replace('- [ ] Pay rent', '- [x] Pay rent ✅ 2026-10-14'));
  expect((await state()).count).toBe(1);
  expect(await restore()).toContain('restored'); expect((await state()).text).toBe(initial);
 });
 it('refuses stale task text and does not change the note', async () => {
  await write(initial.replace('[ ]', '[x]'));
  const changed = initial.replace('- [ ] Pay rent', '- [x] Pay May rent'); await write(changed);
  expect(await restore()).toContain('refused'); expect((await state()).text).toBe(changed);
 });
 it('refuses two matching contexts', async () => {
  const completed = initial.replace('[ ]', '[x]'); await write(completed);
  await write(completed + completed);
  expect(await restore()).toContain('more than one'); expect((await state()).text).toBe(completed + completed);
 });
 it('skips a recurring insertion, a multi-task update, and a prose update', async () => {
  await write(initial.replace('[ ]', '[x]') + '- [ ] Pay rent 🔁 monthly\n');
  expect((await state()).count).toBe(0);
  await write('- [ ] A\n- [ ] B\n');
  await write('- [x] A\n- [x] B\n'); expect((await state()).count).toBe(0);
  await write(initial); await write(initial.replace('[ ]', '[x]').replace('Journal', 'New journal'));
  expect((await state()).count).toBe(0);
 });
 it('ignores checkboxes in frontmatter and fenced code', async () => {
  const sample = '---\n- [ ] Frontmatter\n---\n```\n- [ ] Code\n```\n';
  await write(sample); await write(sample.replace('[ ] Frontmatter', '[x] Frontmatter'));
  expect((await state()).count).toBe(0);
  await write(sample); await write(sample.replace('[ ] Code', '[x] Code'));
  expect((await state()).count).toBe(0);
 });
 it('keeps ten records and clears the free session on reload', async () => {
  for (let i = 0; i < 11; i++) { await write(initial); await write(initial.replace('[ ]', '[x]')); }
  expect((await state()).count).toBe(10);
  expect(await reloadPlugin(pluginId)).toEqual({ enabled: true, reloaded: true, errors: [] });
  expect((await state()).count).toBe(0);
 });
 it('blocks Pro profile actions in the free tier', async () => {
  const result = await browser.executeObsidian(async ({ app }, id) => {
   const plugin = (app as unknown as { plugins: { plugins: Record<string, TaskQueryUndoPlugin> } }).plugins.plugins[id]!;
   return [await plugin.saveProfile('Home'), await plugin.useProfile('Home')];
  }, pluginId);
  expect(result).toEqual([false, false]);
 });
 it('keeps longer Pro history across a reload with a cached Sponsors reply', async () => {
  await setPro();
  for (let i = 0; i < 11; i++) { await write(initial); await write(initial.replace('[ ]', '[x]')); }
  expect((await state()).count).toBe(11);
  await browser.executeObsidian(async ({ app }, id) => {
   const plugin = (app as unknown as { plugins: { plugins: Record<string, TaskQueryUndoPlugin> } }).plugins.plugins[id]!;
   plugin.settings.filter = 'rent'; await plugin.saveProfile('Finance');
  }, pluginId);
  expect(await reloadPlugin(pluginId)).toEqual({ enabled: true, reloaded: true, errors: [] });
  expect((await state()).count).toBe(11);
  const saved = await browser.executeObsidian(async ({ app }, id) => {
   const plugin = (app as unknown as { plugins: { plugins: Record<string, TaskQueryUndoPlugin> } }).plugins.plugins[id]!;
   return { applied: await plugin.useProfile('Finance'), filter: plugin.settings.filter };
  }, pluginId);
  expect(saved).toEqual({ applied: true, filter: 'rent' });
 });
});
