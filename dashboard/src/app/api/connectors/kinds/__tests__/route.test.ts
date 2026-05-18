import { describe, it, expect } from 'vitest';
import { GET } from '../route';

describe('GET /api/connectors/kinds', () => {
  it('returns the connector catalog with a stable schema', async () => {
    const res = GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: number;
      kinds: Array<{ value: string; label: string; description: string; envKeys: string[] }>;
    };
    expect(body.version).toBe(1);
    expect(Array.isArray(body.kinds)).toBe(true);
    expect(body.kinds.length).toBeGreaterThanOrEqual(2);

    const byValue = new Map(body.kinds.map(k => [k.value, k]));
    const telegram = byValue.get('telegram');
    const none = byValue.get('none');

    expect(telegram).toBeDefined();
    expect(telegram!.envKeys).toEqual(['BOT_TOKEN', 'CHAT_ID', 'ALLOWED_USER']);
    expect(telegram!.label).toBe('Telegram');

    expect(none).toBeDefined();
    expect(none!.envKeys).toEqual([]);
  });

  it('every kind has a non-empty label, description, and envKeys array', async () => {
    const res = GET();
    const body = (await res.json()) as { kinds: Array<{ label: string; description: string; envKeys: unknown }> };
    for (const k of body.kinds) {
      expect(k.label.length).toBeGreaterThan(0);
      expect(k.description.length).toBeGreaterThan(0);
      expect(Array.isArray(k.envKeys)).toBe(true);
    }
  });
});
