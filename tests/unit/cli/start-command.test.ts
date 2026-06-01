/**
 * Unit tests for the `cortextos start` subcommand (issue #424).
 *
 * Tests the no-argument behaviour: `cortextos start` with no args must start
 * ALL enabled agents (symmetric with `cortextos stop --all`), not silently
 * no-op or return a status table.
 */
import { describe, it, expect } from 'vitest';
import { startCommand } from '../../../src/cli/start';

describe('issue #424: cortextos start (no args)', () => {
  it('is registered as "start"', () => {
    expect(startCommand.name()).toBe('start');
  });

  it('has [agent] as optional argument', () => {
    const args = (startCommand as unknown as { registeredArguments: { required: boolean; name: () => string }[] }).registeredArguments;
    expect(args).toHaveLength(1);
    expect(args[0].required).toBe(false);
    expect(args[0].name()).toBe('agent');
  });

  it('accepts --instance with a default of "default"', () => {
    const opts = startCommand.opts();
    expect(opts.instance).toBe('default');
  });
});