/**
 * Tests the pre-hydration script by evaluating it against a minimal DOM
 * stub. We don't pull in jsdom for one test file — the script's surface
 * is small enough to stub document + localStorage directly.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PRE_HYDRATION_SCRIPT } from '../pre-hydration-script';

interface FakeDataset { density?: string }
interface FakeElement {
  id?: string;
  textContent?: string;
}
interface FakeDoc {
  documentElement: { dataset: FakeDataset };
  head: { appended: FakeElement[]; appendChild: (el: FakeElement) => void };
  getElementById: (id: string) => FakeElement | null;
  createElement: (tag: string) => FakeElement;
}

function buildEnv(initialStorage: Record<string, string>) {
  const storage: Record<string, string> = { ...initialStorage };
  const localStorage = {
    getItem: (k: string) => (k in storage ? storage[k] : null),
    setItem: (k: string, v: string) => { storage[k] = v; },
  };
  const appended: FakeElement[] = [];
  const document: FakeDoc = {
    documentElement: { dataset: {} },
    head: {
      appended,
      appendChild(el: FakeElement) { appended.push(el); },
    },
    getElementById(id: string) {
      return appended.find(el => el.id === id) ?? null;
    },
    createElement(_tag: string) {
      return { id: undefined, textContent: undefined };
    },
  };
  return { localStorage, document, appended };
}

function runScript(env: ReturnType<typeof buildEnv>) {
  // Evaluate the script with our fakes bound as locals.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('localStorage', 'document', PRE_HYDRATION_SCRIPT)(env.localStorage, env.document);
}

describe('PRE_HYDRATION_SCRIPT', () => {
  let env: ReturnType<typeof buildEnv>;

  beforeEach(() => {
    env = buildEnv({});
  });

  it('no-ops with empty localStorage — no density, no theme injection', () => {
    runScript(env);
    expect(env.document.documentElement.dataset.density).toBeUndefined();
    expect(env.appended).toHaveLength(0);
  });

  it('applies compact density when saved', () => {
    env = buildEnv({ 'ctx-density': 'compact' });
    runScript(env);
    expect(env.document.documentElement.dataset.density).toBe('compact');
  });

  it('applies comfortable density when saved', () => {
    env = buildEnv({ 'ctx-density': 'comfortable' });
    runScript(env);
    expect(env.document.documentElement.dataset.density).toBe('comfortable');
  });

  it('ignores garbage density values', () => {
    env = buildEnv({ 'ctx-density': 'enormous' });
    runScript(env);
    expect(env.document.documentElement.dataset.density).toBeUndefined();
  });

  it('injects per-org theme CSS into a new <style> element', () => {
    const css = ':root { --primary: oklch(0.7 0.2 200); }';
    env = buildEnv({ 'ctx-org-theme-css': css });
    runScript(env);
    expect(env.appended).toHaveLength(1);
    expect(env.appended[0].id).toBe('ctx-org-theme-override');
    expect(env.appended[0].textContent).toBe(css);
  });

  it('rejects oversized theme CSS (sanity ceiling)', () => {
    const huge = ':root { /* ' + 'x'.repeat(10_000) + ' */ }';
    env = buildEnv({ 'ctx-org-theme-css': huge });
    runScript(env);
    expect(env.appended).toHaveLength(0);
  });

  it('handles both density + theme css together', () => {
    const css = ':root { --primary: #abcdef; }';
    env = buildEnv({ 'ctx-density': 'compact', 'ctx-org-theme-css': css });
    runScript(env);
    expect(env.document.documentElement.dataset.density).toBe('compact');
    expect(env.appended[0].textContent).toBe(css);
  });

  it('swallows localStorage errors without throwing', () => {
    const breakingLocalStorage = {
      getItem: () => { throw new Error('storage disabled'); },
      setItem: () => {},
    } as unknown as Storage;
    const document: FakeDoc = {
      documentElement: { dataset: {} },
      head: { appended: [], appendChild: () => {} },
      getElementById: () => null,
      createElement: () => ({}),
    };
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      new Function('localStorage', 'document', PRE_HYDRATION_SCRIPT)(breakingLocalStorage, document);
    }).not.toThrow();
  });
});
