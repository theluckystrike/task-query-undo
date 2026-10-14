import { describe, expect, it } from 'vitest';
import vectors from './vectors/task-query-undo.json';
import * as engine from '../src/engine';

describe('Golden acceptance vectors', () => {
 it('contains at least twenty cases', () => expect(vectors.cases.length).toBeGreaterThanOrEqual(20));
 for (const c of vectors.cases) it(c.name, () => {
  const fn = engine[c.function as keyof typeof engine] as (...args: unknown[]) => unknown;
  let result: unknown;
  try { result = fn(...c.args); } catch (error) { result = { error: (error as Error).message }; }
  expect(result).toEqual(c.expected);
 });
});
