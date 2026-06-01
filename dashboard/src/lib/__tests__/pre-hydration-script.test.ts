/**
 * Tests the pre-hydration script by evaluating it against a minimal DOM stub.
 * The script is small enough that a bespoke fake DOM is cleaner than pulling
 * in a full browser environment.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { PRE_HYDRATION_SCRIPT } from '../pre-hydration-script';

interface FakeElement {
  id?: string;
  textContent?: string;
}

interface FakeDoc {
  documentElement: { dataset: Record<string, string> };
  head: { appendChild: (el: FakeElement) => void };
  getElementById: (id: string) => FakeElement | null;
  createElement: (tag: string) => FakeElement;
}

function buildEnv(initial: {
  density?: string;
  bootstrapCss?: string;
  bootstrapPayload?: string;
} = {}) {
  const storage: Record<string, string> = {};
  if (initial.density) storage['ctx-density'] = initial.density;

  const nodes = new Map<string, FakeElement>();
  if (initial.bootstrapPayload !== undefined) {
    nodes.set('ctx-theme-bootstrap', { id: 'ctx-theme-bootstrap', textContent: initial.bootstrapPayload });
  } else if (initial.bootstrapCss !== undefined) {
    nodes.set('ctx-theme-bootstrap', {
      id: 'ctx-theme-bootstrap',
      textContent: JSON.stringify({ css: initial.bootstrapCss }),
    });
  }

  const appended: FakeElement[] = [];
  const document: FakeDoc = {
    documentElement: { dataset: {} },
    head: {
      appendChild(el: FakeElement) {
        appended.push(el);
        if (el.id) nodes.set(el.id, el);
      },
    },
    getElementById(id: string) {
      return nodes.get(id) ?? null;
    },
    createElement(_tag: string) {
      return { id: undefined, textContent: undefined };
    },
  };

  const localStorage = {
    getItem(key: string) {
      return key in storage ? storage[key] : null;
    },
    setItem(key: string, value: string) {
      storage[key] = value;
    },
  };

  return { document, localStorage, appended };
}

function runScript(env: ReturnType<typeof buildEnv>) {
  new Function('localStorage', 'document', PRE_HYDRATION_SCRIPT)(env.localStorage, env.document);
}

describe('PRE_HYDRATION_SCRIPT', () => {
  let env: ReturnType<typeof buildEnv>;

  beforeEach(() => {
    env = buildEnv();
  });

  it('applies density and injects the resolved theme CSS before hydration', () => {
    env = buildEnv({
      density: 'compact',
      bootstrapCss: ':root { --primary: oklch(0.7 0.2 200); }',
    });

    runScript(env);

    expect(env.document.documentElement.dataset.density).toBe('compact');
    expect(env.appended).toHaveLength(1);
    expect(env.appended[0].id).toBe('ctx-theme-package-css');
    expect(env.appended[0].textContent).toBe(':root { --primary: oklch(0.7 0.2 200); }');
  });

  it('no-ops when there is no bootstrap payload', () => {
    runScript(env);

    expect(env.document.documentElement.dataset.density).toBeUndefined();
    expect(env.appended).toHaveLength(0);
  });

  it('ignores oversized bootstrap CSS', () => {
    env = buildEnv({
      bootstrapCss: 'x'.repeat(33000),
    });

    runScript(env);

    expect(env.appended).toHaveLength(0);
  });

  it('swallows malformed bootstrap payloads without throwing', () => {
    env = buildEnv({
      bootstrapPayload: '{ not json',
    });

    expect(() => runScript(env)).not.toThrow();
    expect(env.appended).toHaveLength(0);
  });

  it('updates an existing style tag when one is already present', () => {
    const style = { id: 'ctx-theme-package-css', textContent: '' };
    env = buildEnv({
      bootstrapCss: ':root { --primary: oklch(0.4 0.2 90); }',
    });
    env.document.getElementById = (id: string) => {
      if (id === 'ctx-theme-package-css') return style;
      return id === 'ctx-theme-bootstrap'
        ? { id: 'ctx-theme-bootstrap', textContent: JSON.stringify({ css: ':root { --primary: oklch(0.4 0.2 90); }' }) }
        : null;
    };

    runScript(env);

    expect(style.textContent).toBe(':root { --primary: oklch(0.4 0.2 90); }');
    expect(env.appended).toHaveLength(0);
  });
});
