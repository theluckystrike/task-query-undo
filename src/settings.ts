import { normalizePath, PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { sponsorsSettingItems } from './license/github-obsidian';
import { PRO_UI } from './pro';
import type TaskQueryUndoPlugin from './main';

export interface Profile { name: string; folder: string; filter: string }
export interface TaskQueryUndoSettings { folder: string; filter: string; profiles: Profile[] }
export const DEFAULT_SETTINGS: TaskQueryUndoSettings = { folder: '', filter: '', profiles: [] };

export function normalizeSettings(saved: unknown): TaskQueryUndoSettings {
 const s = saved && typeof saved === 'object' ? saved as Partial<TaskQueryUndoSettings> : {};
 const profiles = Array.isArray(s.profiles) ? s.profiles.filter((p: unknown): p is Profile => !!p && typeof p === 'object' && typeof (p as Profile).name === 'string' && typeof (p as Profile).folder === 'string' && typeof (p as Profile).filter === 'string') : [];
 return { folder: typeof s.folder === 'string' ? normalizePath(s.folder.trim()) : '', filter: typeof s.filter === 'string' ? s.filter.slice(0, 200) : '', profiles: profiles.slice(-20).map(p => ({ name: p.name.slice(0, 80), folder: normalizePath(p.folder), filter: p.filter.slice(0, 200) })) };
}

export class TaskQueryUndoSettingTab extends PluginSettingTab {
 constructor(app: ConstructorParameters<typeof PluginSettingTab>[0], readonly plugin: TaskQueryUndoPlugin) { super(app, plugin); }
 getSettingDefinitions(): SettingDefinitionItem[] {
  return [
   { name: 'Selected folder', desc: 'Watch Markdown notes in this folder and its subfolders. An empty path stops tracking.', control: { type: 'text', key: 'folder', defaultValue: '' } },
   { name: 'Baseline scan', desc: 'Start again after you create or move a note. The scan does not create history records.', render: setting => { setting.addButton(b => b.setButtonText('Start scan').onClick(() => this.plugin.scan())); } },
   { name: 'Checkbox history', desc: 'Review the old and new line before you restore.', render: setting => { setting.addButton(b => b.setButtonText('Open history').onClick(() => this.plugin.showHistory())); } },
   ...(this.plugin.pro ? sponsorsSettingItems(this.plugin.pro, PRO_UI) : []),
  ];
 }
 async setControlValue(key: string, value: unknown): Promise<void> {
  if (key === 'folder' && typeof value === 'string') await this.plugin.selectFolder(value);
 }
}
