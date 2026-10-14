export const FILE_LIMIT = 1024 * 1024;
export const FOLDER_LIMIT = 20 * FILE_LIMIT;
export const HISTORY_LIMIT = 100;
export const HISTORY_BYTES = FOLDER_LIMIT;

export interface Change {
 id: string;
 path: string;
 folder: string;
 time: number;
 fileCreatedAt?: number;
 before: string;
 after: string;
 previous: string | null;
 next: string | null;
}

export function bytes(text: string): number { return new TextEncoder().encode(text).length; }

export function inFolder(path: string, folder: string): boolean {
 return folder !== '' && path.startsWith(folder + '/');
}

/** Exclude frontmatter, fences, indented code, and recurring tasks. */
export function taskMask(lines: string[]): boolean[] {
 let frontmatter = lines[0]?.replace(/^\uFEFF/, '').replace(/\r$/, '') === '---';
 let fence = '';
 let fenceLength = 0;
 return lines.map((raw, index) => {
  const line = raw.replace(/\r$/, '');
  if (frontmatter) {
   if (index > 0 && /^(---|\.\.\.)\s*$/.test(line)) frontmatter = false;
   return false;
  }
  const marker = /^(?: {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (marker) {
   const marks = marker[1] ?? '';
   if (!fence) { fence = marks[0] ?? ''; fenceLength = marks.length; }
   else if (marks[0] === fence && marks.length >= fenceLength && !(marker[2] ?? '').trim()) fence = '';
   return false;
  }
  return !fence && /^ {0,3}[-+*] \[[ xX]\] .+/.test(line) && !/🔁|\[repeat::/i.test(line);
 });
}

export function detect(before: string, after: string): Omit<Change, 'id' | 'path' | 'folder' | 'time'> | null {
 if (bytes(before) > FILE_LIMIT || bytes(after) > FILE_LIMIT) return null;
 const a = before.split('\n');
 const b = after.split('\n');
 if (a.length !== b.length) return null;
 const changed: number[] = [];
 for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed.push(i);
 if (changed.length !== 1) return null;
 const i = changed[0]!;
 if (!taskMask(a)[i] || !taskMask(b)[i]) return null;
 const old = a[i]!;
 const now = b[i]!;
 const match = /^( {0,3}[-+*] )\[ \]( .+?)(\r?)$/.exec(old);
 if (!match) return null;
 const checked = /^ {0,3}[-+*] \[([xX])\]/.exec(now);
 if (!checked) return null;
 const base = `${match[1]}[${checked[1]}]${match[2]}`;
 const eol = match[3] ?? '';
 if (now !== base + eol && !new RegExp('^' + escapeRegex(base) + ' ✅ \\d{4}-\\d{2}-\\d{2}' + eol + '$').test(now)) return null;
 return { before: old, after: now, previous: b[i - 1] ?? null, next: b[i + 1] ?? null };
}

function escapeRegex(text: string): string { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export class Refusal extends Error {}

/** The caller runs this function inside Vault.process. A refusal throws before a write. */
export function restoreText(text: string, change: Change): string {
 if (bytes(text) > FILE_LIMIT) throw new Refusal('Restore refused: the note is larger than 1 MiB.');
 const lines = text.split('\n');
 const matches: number[] = [];
 for (let i = 0; i < lines.length; i++) {
  if (lines[i] === change.after && (lines[i - 1] ?? null) === change.previous && (lines[i + 1] ?? null) === change.next) matches.push(i);
 }
 if (matches.length !== 1) throw new Refusal(matches.length > 1 ? 'Restore refused: more than one line matches.' : 'Restore refused: the line or its context changed.');
 const index = matches[0]!;
 if (!taskMask(lines)[index]) throw new Refusal('Restore refused: this line is no longer an eligible task.');
 lines[index] = change.before;
 return lines.join('\n');
}

export function trimHistory(history: Change[], pro: boolean): Change[] {
 if (!pro) return history.slice(-10);
 const result = history.slice(-HISTORY_LIMIT);
 while (result.length && bytes(JSON.stringify(result)) > HISTORY_BYTES) result.shift();
 return result;
}

export function loadHistory(saved: unknown): Change[] {
 if (!Array.isArray(saved)) return [];
 const valid = saved.filter((x: unknown): x is Change => {
  if (!x || typeof x !== 'object') return false;
  const c = x as Partial<Change>;
  return typeof c.id === 'string' && typeof c.path === 'string' && typeof c.folder === 'string' && typeof c.time === 'number' && Number.isFinite(c.time)
   && typeof c.before === 'string' && typeof c.after === 'string' && (c.previous === null || typeof c.previous === 'string') && (c.next === null || typeof c.next === 'string')
   && detect(c.before, c.after) !== null;
 });
 return trimHistory(valid, true);
}
