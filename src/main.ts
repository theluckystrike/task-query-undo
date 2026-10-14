import { Notice, Plugin, TFile, normalizePath } from 'obsidian';
import type { SponsorsManager } from './license/index';
import { createGitHubSponsors } from './license/github-obsidian';
import { bindPro, isPro, resetPro, SPONSORS } from './pro';
import { bytes, detect, FILE_LIMIT, FOLDER_LIMIT, inFolder, loadHistory, Refusal, restoreText, trimHistory, type Change } from './engine';
import { DEFAULT_SETTINGS, normalizeSettings, TaskQueryUndoSettingTab, type TaskQueryUndoSettings } from './settings';
import { HistoryModal } from './view';

export default class TaskQueryUndoPlugin extends Plugin {
 settings: TaskQueryUndoSettings = { ...DEFAULT_SETTINGS, profiles: [] };
 pro: SponsorsManager | null = null;
 history: Change[] = [];
 baseline = new Map<string, string>();
 skipped = new Map<string, string>();
 ready = false;
 status = 'Select a folder, then start the baseline scan.';
 private queue: Promise<void> = Promise.resolve();
 private active = true;
 private sequence = 0;
 private tab: TaskQueryUndoSettingTab | null = null;
 private historyLoaded = false;
 readonly modals = new Set<HistoryModal>();

 async onload(): Promise<void> {
  await this.loadSettings();
  this.pro = createGitHubSponsors(this.app, this.manifest.id, SPONSORS, this);
  this.pro.init();
  bindPro(this.pro);
  this.loadLocalHistory();
  this.tab = new TaskQueryUndoSettingTab(this.app, this);
  this.addSettingTab(this.tab);
  this.register(this.pro.onChange(() => {
   if (!isPro()) this.historyLoaded = false;
   this.loadLocalHistory();
   this.history = trimHistory(this.history, isPro());
   this.changed();
   this.tab?.update();
  }));
  this.addCommand({ id: 'start-scan', name: 'Start the baseline scan', callback: () => { void this.scan(); } });
  this.addCommand({ id: 'show-history', name: 'Show recent checkbox changes', callback: () => this.showHistory() });
  this.registerEvent(this.app.vault.on('modify', file => {
   if (file instanceof TFile && file.extension === 'md') void this.observe(file);
  }));
  this.registerEvent(this.app.vault.on('delete', file => this.invalidate(file.path)));
  this.registerEvent(this.app.vault.on('rename', (_file, oldPath) => this.invalidate(oldPath)));
  this.app.workspace.onLayoutReady(() => {
   if (!this.active) return;
   void this.pro?.refresh();
   this.registerInterval(window.setInterval(() => { void this.pro?.refresh(); }, 6 * 60 * 60 * 1000));
   if (this.settings.folder) void this.scan();
  });
 }

 onunload(): void {
  this.active = false;
  for (const modal of [...this.modals]) modal.close();
  this.baseline.clear();
  resetPro();
 }

 async loadSettings(): Promise<void> { this.settings = normalizeSettings(await this.loadData() as unknown); }
 async saveSettings(): Promise<void> { await this.saveData(this.settings); }

 private enqueue<T>(action: () => Promise<T>): Promise<T> {
  const result = this.queue.then(action);
  this.queue = result.then(() => undefined, () => undefined);
  return result;
 }

 async flush(): Promise<void> { await this.queue; }

 async selectFolder(folder: string): Promise<void> {
  this.settings.folder = normalizePath(folder.trim());
  this.ready = false;
  await this.saveSettings();
  await this.scan();
 }

 async scan(): Promise<void> {
  return this.enqueue(async () => {
   if (!this.active) return;
   this.ready = false;
   this.baseline.clear();
   this.skipped.clear();
   const folder = this.settings.folder;
   if (!folder) { this.status = 'Select a folder, then start the baseline scan.'; this.changed(); return; }
   let total = 0;
   for (const file of this.app.vault.getMarkdownFiles().sort((a, b) => a.path.localeCompare(b.path))) {
    if (!this.active) return;
    if (!inFolder(file.path, folder)) continue;
    const path = file.path;
    if (file.stat.size > FILE_LIMIT) { this.skipped.set(file.path, 'File exceeds 1 MiB'); continue; }
    try {
     const text = await this.app.vault.cachedRead(file);
     if (!this.active) return;
     if (this.settings.folder !== folder) return;
     if (file.path !== path || this.app.vault.getFileByPath(path) !== file) continue;
     const size = bytes(text);
     if (size > FILE_LIMIT || total + size > FOLDER_LIMIT) { this.skipped.set(file.path, size > FILE_LIMIT ? 'File exceeds 1 MiB' : 'Folder exceeds 20 MiB'); continue; }
     this.baseline.set(file.path, text);
     total += size;
    } catch { this.skipped.set(file.path, 'Read failed'); }
   }
   this.ready = true;
   this.status = `Watching ${this.baseline.size} notes in ${folder}. ${this.skipped.size} notes skipped.`;
   this.changed();
  }).catch(() => { this.status = 'Baseline scan failed. Start the scan again.'; this.changed(); });
 }

 async observe(file: TFile): Promise<void> {
  const path = file.path;
  return this.enqueue(async () => {
   const folder = this.settings.folder;
   if (!this.active || !this.ready || file.path !== path || !inFolder(path, folder)) return;
   const previous = this.baseline.get(path);
   // A new or skipped note needs a new baseline scan.
   if (previous === undefined) return;
   if (file.stat.size > FILE_LIMIT) { this.baseline.delete(file.path); this.skipped.set(file.path, 'File exceeds 1 MiB'); this.changed(); return; }
   const current = await this.app.vault.read(file);
   if (!this.active || !this.ready || this.settings.folder !== folder || file.path !== path || this.app.vault.getFileByPath(path) !== file) return;
   const size = bytes(current);
   const total = [...this.baseline.values()].reduce((n, text) => n + bytes(text), 0) - bytes(previous) + size;
   if (size > FILE_LIMIT || total > FOLDER_LIMIT) {
    this.baseline.delete(file.path);
    this.skipped.set(file.path, size > FILE_LIMIT ? 'File exceeds 1 MiB' : 'Folder exceeds 20 MiB');
    this.changed(); return;
   }
   this.baseline.set(file.path, current);
   const change = detect(previous, current);
   if (change) {
    this.history.push({ ...change, id: `${Date.now()}-${++this.sequence}`, path: file.path, folder: this.settings.folder, time: Date.now(), fileCreatedAt: file.stat.ctime });
    this.history = trimHistory(this.history, isPro());
    this.changed();
   }
  }).catch(() => {
   this.baseline.delete(file.path);
   this.skipped.set(file.path, 'Read failed; start a new scan');
   this.changed();
  });
 }

 async restore(id: string): Promise<string> {
  return this.enqueue(async () => {
   if (!this.active) return 'Restore refused: the plugin is no longer active.';
   const change = this.history.find(c => c.id === id);
   if (!change) return 'Restore refused: this record is no longer in history.';
   if (!inFolder(change.path, this.settings.folder)) return 'Restore refused: select the folder of this record first.';
   const file = this.app.vault.getFileByPath(change.path);
   if (!file) return 'Restore refused: the note was moved or deleted.';
   if (file.stat.ctime !== change.fileCreatedAt) return 'Restore refused: the note creation time does not match the record.';
   try {
    const current = await this.app.vault.process(file, text => {
     if (!this.active) throw new Refusal('Restore refused: the plugin is no longer active.');
     if (file.path !== change.path || this.app.vault.getFileByPath(change.path) !== file) throw new Refusal('Restore refused: the note was moved or deleted.');
     if (file.stat.ctime !== change.fileCreatedAt) throw new Refusal('Restore refused: the note creation time does not match the record.');
     return restoreText(text, change);
    });
    // Keep the atomic result so a later completion remains visible to the observer.
    if (!this.active) return 'Task line restored. Other lines are kept.';
    if (this.baseline.has(file.path)) this.baseline.set(file.path, current);
    this.history = this.history.filter(c => c.id !== id);
    this.changed();
    return 'Task line restored. Other lines are kept.';
   } catch (error) {
    return error instanceof Refusal ? error.message : 'Restore failed: the note could not be written.';
   }
  });
 }

 private invalidate(path: string): void {
  void this.enqueue(async () => {
   for (const key of this.baseline.keys()) if (key === path || key.startsWith(path + '/')) this.baseline.delete(key);
   this.history = this.history.filter(c => c.path !== path && !c.path.startsWith(path + '/'));
   this.changed();
  });
 }

 private loadLocalHistory(): void {
  if (!isPro() || this.historyLoaded) return;
  try {
   const records = [...loadHistory(this.app.loadLocalStorage(`${this.manifest.id}-history`)), ...this.history];
   this.history = trimHistory([...new Map(records.map(change => [change.id, change])).values()], true);
   this.historyLoaded = true;
  } catch { this.status = 'Local history could not be read. Current history stays in memory.'; }
 }

 changed(): void {
  if (isPro()) {
   this.loadLocalHistory();
   if (this.historyLoaded) {
    try { this.app.saveLocalStorage(`${this.manifest.id}-history`, this.history); }
    catch { this.status = 'Local history could not be saved. Current history stays in memory.'; }
   }
  }
  for (const modal of this.modals) modal.render();
 }

 showHistory(): void { new HistoryModal(this.app, this).open(); }

 async saveProfile(name: string): Promise<boolean> {
  if (!isPro() || !name.trim() || !this.settings.folder) return false;
  this.settings.profiles = [...this.settings.profiles.filter(p => p.name !== name.trim()), { name: name.trim(), folder: this.settings.folder, filter: this.settings.filter }].slice(-20);
  await this.saveSettings(); return true;
 }

 async useProfile(name: string): Promise<boolean> {
  if (!isPro()) return false;
  const profile = this.settings.profiles.find(p => p.name === name);
  if (!profile) return false;
  this.settings.filter = profile.filter;
  await this.selectFolder(profile.folder); return true;
 }

 async clearHistory(): Promise<void> {
  let cleared = true;
  await this.enqueue(async () => {
   this.history = [];
   this.historyLoaded = true;
   try { this.app.saveLocalStorage(`${this.manifest.id}-history`, null); }
   catch { cleared = false; this.status = 'The tool cannot clear saved history. Current history is empty. Try again.'; }
   this.changed();
  });
  new Notice(cleared ? 'Checkbox history cleared.' : this.status);
 }
}
