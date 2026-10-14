import { Modal, Setting, type App } from 'obsidian';
import type TaskQueryUndoPlugin from './main';
import { isPro } from './pro';

export class HistoryModal extends Modal {
 message = '';
 profileName = '';
 constructor(app: App, readonly plugin: TaskQueryUndoPlugin) { super(app); }
 onOpen(): void { this.plugin.modals.add(this); this.modalEl.addClass('tqu-modal'); this.setTitle('Recent checkbox changes'); this.render(); }
 onClose(): void { this.plugin.modals.delete(this); this.contentEl.empty(); }
 render(): void {
  const el = this.contentEl;
  el.empty();
  el.createEl('p', { text: this.plugin.status, cls: 'tqu-status' });
  el.createEl('p', { text: isPro() ? 'Pro history: up to 100 records, stored on this device.' : 'Free history: the last ten eligible changes in this session.' });
  new Setting(el).setName('Folder').addText(t => t.setValue(this.plugin.settings.folder).onChange(value => { this.plugin.settings.folder = value; this.plugin.ready = false; }))
   .addButton(b => b.setButtonText('Start scan').onClick(async () => { await this.plugin.selectFolder(this.plugin.settings.folder); this.render(); }));
  if (this.message) el.createEl('p', { text: this.message, cls: 'tqu-result', attr: { role: 'status' } });
  if (isPro()) {
   new Setting(el).setName('History filter').setDesc('Match note path or task text. Saved with the current profile.')
    .addText(t => t.setValue(this.plugin.settings.filter).onChange(async value => { this.plugin.settings.filter = value.slice(0, 200); await this.plugin.saveSettings(); this.renderRecords(); }));
   new Setting(el).setName('Folder profiles').addText(t => t.setPlaceholder('Profile name').setValue(this.profileName).onChange(value => { this.profileName = value; }))
    .addButton(b => b.setButtonText('Save profile').onClick(async () => { this.message = await this.plugin.saveProfile(this.profileName) ? 'Folder profile saved.' : 'Enter a name and select a folder.'; this.render(); }));
   for (const profile of this.plugin.settings.profiles) new Setting(el).setName(profile.name).setDesc(profile.folder).addButton(b => b.setButtonText('Use profile').onClick(async () => { await this.plugin.useProfile(profile.name); this.render(); }));
  }
  el.createDiv({ cls: 'tqu-records' });
  this.renderRecords();
  if (this.plugin.skipped.size) {
   new Setting(el).setName('Skipped notes').setHeading();
   for (const [path, reason] of this.plugin.skipped) el.createEl('p', { text: `${path}: ${reason}` });
  }
  new Setting(el).setName('Clear history').setDesc('Remove the recovery records. This does not change notes.').addButton(b => b.setButtonText('Clear history').onClick(() => this.plugin.clearHistory()));
 }
 renderRecords(): void {
  const list = this.contentEl.querySelector<HTMLElement>('.tqu-records');
  if (!list) return;
  list.empty();
  const filter = isPro() ? this.plugin.settings.filter.toLowerCase() : '';
  const records = this.plugin.history.filter(c => !filter || `${c.path}\n${c.before}\n${c.after}`.toLowerCase().includes(filter));
  if (!records.length) list.createEl('p', { text: 'No matching recovery records. Complete one task after the baseline scan.' });
  for (const record of [...records].reverse()) {
   const card = list.createDiv({ cls: 'tqu-record', attr: { 'data-record-id': record.id } });
   card.createEl('p', { text: `${record.path} · ${new Date(record.time).toLocaleString()}`, cls: 'tqu-path' });
   card.createDiv( { text: 'Before', cls: 'tqu-label' });
   card.createEl('pre', { text: record.before, cls: 'tqu-before' });
   card.createDiv( { text: 'After', cls: 'tqu-label' });
   card.createEl('pre', { text: record.after, cls: 'tqu-after' });
   new Setting(card).setName('Restore this exact line').setDesc('The line and its adjacent lines must still match.')
    .addButton(b => b.setButtonText('Open note').onClick(async () => { const file = this.app.vault.getFileByPath(record.path); if (file) { this.close(); await this.app.workspace.getLeaf('tab').openFile(file); } }))
    .addButton(b => b.setButtonText('Restore line').setCta().onClick(async () => { b.setDisabled(true); this.message = await this.plugin.restore(record.id); this.render(); }));
  }
 }
}
