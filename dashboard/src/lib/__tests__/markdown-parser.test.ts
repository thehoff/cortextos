import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import {
  parseMarkdown,
  serializeMarkdown,
  parseIdentityMd,
  serializeIdentityMd,
  parseSoulMd,
  serializeSoulMd,
  parseGoalsMd,
  serializeGoalsMd,
} from '../markdown-parser';

// ---------------------------------------------------------------------------
// Generic parser round-trip
// ---------------------------------------------------------------------------

describe('parseMarkdown / serializeMarkdown', () => {
  it('round-trips simple markdown with multiple sections', () => {
    const input = `# Title

Some preamble text.

## Section One
Content of section one.

## Section Two
Content of section two.
`;
    expect(serializeMarkdown(parseMarkdown(input))).toBe(input);
  });

  it('round-trips empty string', () => {
    expect(serializeMarkdown(parseMarkdown(''))).toBe('');
  });

  it('round-trips file with no headings (all preamble)', () => {
    const input = 'Just some plain text\nwith multiple lines.\n';
    expect(serializeMarkdown(parseMarkdown(input))).toBe(input);
  });

  it('round-trips file with nested headings', () => {
    const input = `## Main Section
Some content.

### Sub Section
Sub content.

## Another Section
More content.
`;
    const parsed = parseMarkdown(input);
    expect(parsed.sections).toHaveLength(3);
    expect(parsed.sections[0].heading).toBe('Main Section');
    expect(parsed.sections[1].heading).toBe('Sub Section');
    expect(parsed.sections[1].level).toBe(3);
    expect(serializeMarkdown(parsed)).toBe(input);
  });

  it('round-trips file with duplicate heading names', () => {
    const input = `## Notes
First notes.

## Notes
Second notes.
`;
    const parsed = parseMarkdown(input);
    expect(parsed.sections).toHaveLength(2);
    expect(serializeMarkdown(parsed)).toBe(input);
  });

  it('handles preamble before first heading', () => {
    const input = `Preamble line 1
Preamble line 2

## Heading
Content.
`;
    const parsed = parseMarkdown(input);
    expect(parsed.preamble).toBe('Preamble line 1\nPreamble line 2\n');
    expect(parsed.sections).toHaveLength(1);
    expect(serializeMarkdown(parsed)).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// IDENTITY.md
// ---------------------------------------------------------------------------

const SAMPLE_IDENTITY = `## Name
Test Agent

## Role
Orchestrator

## Emoji
🤖

## Vibe
Focused and methodical

## Work Style
Sequential task execution

## Notes
Some custom notes that should survive edits.
`;

describe('parseIdentityMd / serializeIdentityMd', () => {
  it('extracts identity fields correctly', () => {
    const { fields } = parseIdentityMd(SAMPLE_IDENTITY);
    expect(fields.name).toBe('Test Agent');
    expect(fields.role).toBe('Orchestrator');
    expect(fields.emoji).toContain('🤖');
    expect(fields.vibe).toBe('Focused and methodical');
    expect(fields.workStyle).toBe('Sequential task execution');
  });

  it('round-trips identity without edits', () => {
    const { fields, parsed } = parseIdentityMd(SAMPLE_IDENTITY);
    const output = serializeIdentityMd(fields, parsed);
    expect(output).toBe(SAMPLE_IDENTITY);
  });

  it('preserves unknown sections through edit', () => {
    const { fields, parsed } = parseIdentityMd(SAMPLE_IDENTITY);
    fields.name = 'New Name';
    const output = serializeIdentityMd(fields, parsed);

    expect(output).toContain('New Name');
    expect(output).toContain('## Notes');
    expect(output).toContain('Some custom notes');
  });

  it('edited field parses back correctly', () => {
    const { fields, parsed } = parseIdentityMd(SAMPLE_IDENTITY);
    fields.role = 'Analyst';
    const output = serializeIdentityMd(fields, parsed);

    const { fields: reparsed } = parseIdentityMd(output);
    expect(reparsed.role).toBe('Analyst');
    expect(reparsed.name).toBe('Test Agent');
  });

  it('handles empty content', () => {
    const { fields } = parseIdentityMd('');
    expect(fields.name).toBe('');
    expect(fields.role).toBe('');
  });
});

// ---------------------------------------------------------------------------
// SOUL.md
// ---------------------------------------------------------------------------

const SAMPLE_SOUL = `## Autonomy Rules
- Always ask before deploying
- Never modify production data

## Communication Style
Concise, direct, technical

## Day Mode
Active task execution

## Night Mode
Monitoring only

## Core Truths
Ship fast, break nothing.
`;

describe('parseSoulMd / serializeSoulMd', () => {
  it('extracts soul fields correctly', () => {
    const { fields } = parseSoulMd(SAMPLE_SOUL);
    expect(fields.autonomyRules).toContain('Always ask before deploying');
    expect(fields.communicationStyle).toBe('Concise, direct, technical');
    expect(fields.dayMode).toBe('Active task execution');
    expect(fields.nightMode).toBe('Monitoring only');
    expect(fields.coreTruths).toBe('Ship fast, break nothing.');
  });

  it('round-trips soul without edits', () => {
    const { fields, parsed } = parseSoulMd(SAMPLE_SOUL);
    const output = serializeSoulMd(fields, parsed);
    expect(output).toBe(SAMPLE_SOUL);
  });

  it('handles alternate heading "Autonomy" (without Rules)', () => {
    const input = `## Autonomy
Be careful.
`;
    const { fields } = parseSoulMd(input);
    expect(fields.autonomyRules).toBe('Be careful.');
  });

  it('updates explicit-shape Day Mode / Night Mode sections in place', () => {
    // Explicit shape: separate ## Day Mode and ## Night Mode headings.
    const { fields, parsed } = parseSoulMd(SAMPLE_SOUL);
    fields.dayMode = 'Pairing with the operator';
    const out = serializeSoulMd(fields, parsed);

    // Exactly one of each — no orphan combined section spawned.
    expect((out.match(/## Day Mode/g) ?? []).length).toBe(1);
    expect((out.match(/## Night Mode/g) ?? []).length).toBe(1);
    expect(out).not.toContain('## Day/Night Mode');

    const { fields: re } = parseSoulMd(out);
    expect(re.dayMode).toBe('Pairing with the operator');
    expect(re.nightMode).toBe('Monitoring only');
    expect(re.coreTruths).toBe('Ship fast, break nothing.');
  });
});

// ---------------------------------------------------------------------------
// SOUL.md — template heading schemes (issue #39)
//
// Every templates/*/SOUL.md uses the "template shape":
//   ## Autonomy Rules
//   ## Day/Night Mode   (combined, bold **Day Mode (...)** / **Night Mode (...)** sub-lines)
//   ## Communication    (not "Communication Style")
// and has NO Core Truths section. The editor must read those fields (not open
// blank) and save them back IN PLACE without spawning orphan duplicate
// headings. The parser adapts to the templates; templates are never modified.
// ---------------------------------------------------------------------------

// Combined Day/Night, blank line before/between (agent/orchestrator/hermes/codex).
const TEMPLATE_SOUL_SPACED = `# Agent Soul - Core Principles

Read once per session.

---

## Autonomy Rules

**No approval needed:** research, drafts, code on feature branches
**Always ask first:** external communications, merging to main

> Custom rules added during onboarding are written here.

## Day/Night Mode

**Day Mode ({{day_mode_start}} – {{day_mode_end}}):** Responsive and user-directed. Normal heartbeats and workflows.

**Night Mode (outside day hours):** Idle is failure. Work through the task list.

## Communication
- Internal: direct and concise, lead with the answer
- External: org brand voice, professional, opinionated when asked
`;

// Combined Day/Night, no blank lines (analyst template layout).
const TEMPLATE_SOUL_TIGHT = `# Agent Soul - Core Principles

## Autonomy Rules
**No approval needed:** research, drafts
**Always ask first:** external communications

> Custom rules added during onboarding will be inserted here.

## Day/Night Mode
**Day Mode ({{day_mode_start}} - {{day_mode_end}}):** Responsive and user-directed.
**Night Mode (outside day hours):** Idle is failure. Run experiments.

## Communication
- Internal: direct and concise, lead with the answer
`;

describe('parseSoulMd — template heading schemes (#39)', () => {
  it('reads dayMode/nightMode from a combined Day/Night Mode section', () => {
    const { fields } = parseSoulMd(TEMPLATE_SOUL_SPACED);
    expect(fields.dayMode).toContain('Responsive and user-directed');
    expect(fields.dayMode).toContain('**Day Mode');
    expect(fields.nightMode).toContain('Idle is failure');
    expect(fields.nightMode).toContain('**Night Mode');
  });

  it('reads communicationStyle from a "Communication" heading', () => {
    const { fields } = parseSoulMd(TEMPLATE_SOUL_SPACED);
    expect(fields.communicationStyle).toContain('Internal: direct and concise');
  });

  it('reads autonomyRules from the template', () => {
    const { fields } = parseSoulMd(TEMPLATE_SOUL_SPACED);
    expect(fields.autonomyRules).toContain('No approval needed');
  });

  it('treats a missing Core Truths section as empty (does not crash)', () => {
    const { fields } = parseSoulMd(TEMPLATE_SOUL_SPACED);
    expect(fields.coreTruths).toBe('');
  });

  for (const [label, sample] of [
    ['spaced layout', TEMPLATE_SOUL_SPACED] as const,
    ['tight layout', TEMPLATE_SOUL_TIGHT] as const,
  ]) {
    it(`round-trips losslessly with unchanged fields (${label})`, () => {
      const { fields, parsed } = parseSoulMd(sample);
      expect(serializeSoulMd(fields, parsed)).toBe(sample);
    });

    it(`saves with no duplicate headings (${label})`, () => {
      const { fields, parsed } = parseSoulMd(sample);
      const out = serializeSoulMd(fields, parsed);
      const headings = out
        .split('\n')
        .filter((l) => l.startsWith('## '))
        .map((l) => l.slice(3).trim());
      // No orphan "Communication Style" / "Day Mode" / "Night Mode" / "Core Truths".
      expect(out).not.toContain('## Communication Style');
      expect(out).not.toContain('## Day Mode');
      expect(out).not.toContain('## Night Mode');
      expect(out).not.toContain('## Core Truths');
      // Exactly one of each template heading.
      expect(headings.filter((h) => h === 'Communication')).toHaveLength(1);
      expect(headings.filter((h) => h === 'Day/Night Mode')).toHaveLength(1);
      expect(headings.filter((h) => h === 'Autonomy Rules')).toHaveLength(1);
    });
  }

  it('updates communicationStyle in place under the "Communication" heading', () => {
    const { fields, parsed } = parseSoulMd(TEMPLATE_SOUL_SPACED);
    fields.communicationStyle = '- Internal: blunt and fast';
    const out = serializeSoulMd(fields, parsed);

    expect(out).not.toContain('## Communication Style');
    expect(out).toContain('## Communication\n- Internal: blunt and fast');

    const { fields: reparsed } = parseSoulMd(out);
    expect(reparsed.communicationStyle).toBe('- Internal: blunt and fast');
    // Other fields untouched.
    expect(reparsed.autonomyRules).toContain('No approval needed');
    expect(reparsed.dayMode).toContain('Responsive and user-directed');
  });

  it('updates dayMode/nightMode in place within the combined section', () => {
    const { fields, parsed } = parseSoulMd(TEMPLATE_SOUL_SPACED);
    fields.dayMode = '**Day Mode (9-5):** Pairing with the operator.';
    const out = serializeSoulMd(fields, parsed);

    // Still one combined section, no orphan single-mode headings.
    expect(out).not.toContain('## Day Mode');
    expect(out).not.toContain('## Night Mode');
    expect((out.match(/## Day\/Night Mode/g) ?? []).length).toBe(1);

    const { fields: reparsed } = parseSoulMd(out);
    expect(reparsed.dayMode).toContain('Pairing with the operator');
    // Night mode preserved through the edit.
    expect(reparsed.nightMode).toContain('Idle is failure');
  });

  it('replays the source layout when editing a tight-layout combined section', () => {
    const { fields, parsed } = parseSoulMd(TEMPLATE_SOUL_TIGHT);
    fields.dayMode = '**Day Mode (9-5):** Pairing with the operator.';
    const out = serializeSoulMd(fields, parsed);

    // Tight template had NO blank line between Day and Night — keep it that way
    // so a single edit doesn't reflow the whole section into spaced layout.
    expect(out).toContain(
      '**Day Mode (9-5):** Pairing with the operator.\n**Night Mode (outside day hours):** Idle is failure. Run experiments.',
    );
    const { fields: re } = parseSoulMd(out);
    expect(re.dayMode).toContain('Pairing with the operator');
    expect(re.nightMode).toContain('Idle is failure');
  });

  it('preserves spaced layout when editing a spaced combined section', () => {
    const { fields, parsed } = parseSoulMd(TEMPLATE_SOUL_SPACED);
    fields.nightMode = '**Night Mode (outside day hours):** Hold the line.';
    const out = serializeSoulMd(fields, parsed);
    // Spaced template keeps the blank line between Day and Night.
    expect(out).toMatch(/\*\*Day Mode[^\n]*\n\n\*\*Night Mode/);
    const { fields: re } = parseSoulMd(out);
    expect(re.dayMode).toContain('Responsive and user-directed');
    expect(re.nightMode).toContain('Hold the line');
  });

  it('preserves extra notes inside the combined Day/Night section on edit', () => {
    const input = `## Day/Night Mode

Mode policy applies on weekdays only.

**Day Mode (9-5):** Responsive.

**Night Mode (off):** Idle.

> See runbook for exceptions.

## Communication
- concise
`;
    const { fields, parsed } = parseSoulMd(input);
    fields.dayMode = '**Day Mode (9-5):** Pairing.';
    const out = serializeSoulMd(fields, parsed);

    // Surrounding prose must survive a day-only edit.
    expect(out).toContain('Mode policy applies on weekdays only.');
    expect(out).toContain('> See runbook for exceptions.');
    expect(out).toContain('**Day Mode (9-5):** Pairing.');
    expect(out).toContain('**Night Mode (off):** Idle.');
    expect(out).not.toContain('## Day Mode');
    expect(out).not.toContain('## Night Mode');
  });

  it('round-trips a combined section that carries extra notes (unchanged)', () => {
    const input = `## Day/Night Mode

Policy note here.

**Day Mode (9-5):** Responsive.

**Night Mode (off):** Idle.

## Communication
- concise
`;
    const { fields, parsed } = parseSoulMd(input);
    expect(serializeSoulMd(fields, parsed)).toBe(input);
  });

  it('deletes a Day Mode block when the operator clears the field', () => {
    const { fields, parsed } = parseSoulMd(TEMPLATE_SOUL_SPACED);
    fields.dayMode = '';
    const out = serializeSoulMd(fields, parsed);
    // Cleared field must not silently restore the old content.
    expect(out).not.toContain('Responsive and user-directed');
    const { fields: re } = parseSoulMd(out);
    expect(re.dayMode).toBe('');
    expect(re.nightMode).toContain('Idle is failure');
  });

  it('clearing both day and night leaves no duplicate/orphan headings', () => {
    const { fields, parsed } = parseSoulMd(TEMPLATE_SOUL_SPACED);
    fields.dayMode = '';
    fields.nightMode = '';
    const out = serializeSoulMd(fields, parsed);
    expect(out).not.toContain('Responsive and user-directed');
    expect(out).not.toContain('Idle is failure');
    expect(out).not.toContain('## Day Mode');
    expect(out).not.toContain('## Night Mode');
    // Still at most one Day/Night heading (no duplication).
    expect((out.match(/## Day\/Night Mode/g) ?? []).length).toBe(1);
    const { fields: re } = parseSoulMd(out);
    expect(re.dayMode).toBe('');
    expect(re.nightMode).toBe('');
  });

  it('emits one canonical Day/Night Mode section for a fresh file', () => {
    const fresh = `## Autonomy Rules
Be careful.
`;
    const { fields, parsed } = parseSoulMd(fresh);
    fields.dayMode = '**Day Mode (9-5):** Pairing.';
    fields.nightMode = '**Night Mode (off):** Idle.';
    const out = serializeSoulMd(fields, parsed);

    // One combined section, no orphan single-mode headings.
    expect((out.match(/## Day\/Night Mode/g) ?? []).length).toBe(1);
    expect(out).not.toContain('## Day Mode');
    expect(out).not.toContain('## Night Mode');
    // Matches the shipped template layout: blank line under the heading.
    expect(out).toContain('## Day/Night Mode\n\n**Day Mode');

    const { fields: re } = parseSoulMd(out);
    expect(re.dayMode).toContain('Pairing');
    expect(re.nightMode).toContain('Idle');
  });

  it('restores a Night Mode block that was absent from the source', () => {
    // Combined section with only a Day block present.
    const input = `## Day/Night Mode

**Day Mode (9-5):** Responsive.

## Communication
- concise
`;
    const { fields, parsed } = parseSoulMd(input);
    expect(fields.nightMode).toBe('');
    fields.nightMode = '**Night Mode (off):** Idle.';
    const out = serializeSoulMd(fields, parsed);

    const { fields: re } = parseSoulMd(out);
    expect(re.dayMode).toContain('Responsive');
    expect(re.nightMode).toContain('Idle');
    // Still one combined section, no orphan headings.
    expect((out.match(/## Day\/Night Mode/g) ?? []).length).toBe(1);
    expect(out).not.toContain('## Night Mode\n');
  });

  it('appends Core Truths only when the operator enters content', () => {
    const { fields, parsed } = parseSoulMd(TEMPLATE_SOUL_SPACED);

    // Empty Core Truths must NOT create an orphan section.
    const untouched = serializeSoulMd({ ...fields }, parsed);
    expect(untouched).not.toContain('## Core Truths');

    // Non-empty Core Truths appends exactly one new section.
    fields.coreTruths = 'Ship fast, break nothing.';
    const out = serializeSoulMd(fields, parsed);
    expect((out.match(/## Core Truths/g) ?? []).length).toBe(1);
    expect(out).toContain('Ship fast, break nothing.');

    const { fields: reparsed } = parseSoulMd(out);
    expect(reparsed.coreTruths).toBe('Ship fast, break nothing.');
  });
});

// Round-trip EVERY real templates/*/SOUL.md straight off disk.
describe('parseSoulMd — real template files round-trip (#39)', () => {
  // Resolve the repo-root templates/ dir robustly: prefer the path relative to
  // this test file (works under the dashboard vitest root), fall back to the
  // process cwd so the suite stays portable across runner configs.
  const candidates = [
    join(__dirname, '..', '..', '..', '..', 'templates'),
    join(process.cwd(), 'templates'),
    join(process.cwd(), '..', 'templates'),
  ];
  const templatesDir = candidates.find((p) => existsSync(p)) ?? candidates[0];
  const soulFiles = existsSync(templatesDir)
    ? readdirSync(templatesDir)
        .map((d) => join(templatesDir, d, 'SOUL.md'))
        .filter((p) => existsSync(p))
    : [];

  it('discovers template SOUL.md files', () => {
    expect(soulFiles.length).toBeGreaterThan(0);
  });

  for (const file of soulFiles) {
    const rel = file.split('templates/')[1] ?? file;
    it(`parse->serialize is lossless: ${rel}`, () => {
      const input = readFileSync(file, 'utf-8');
      const { fields, parsed } = parseSoulMd(input);
      expect(serializeSoulMd(fields, parsed)).toBe(input);
    });

    it(`opens non-blank (autonomy + day/night populated): ${rel}`, () => {
      const input = readFileSync(file, 'utf-8');
      const { fields } = parseSoulMd(input);
      expect(fields.autonomyRules.length).toBeGreaterThan(0);
      expect(fields.dayMode.length).toBeGreaterThan(0);
      expect(fields.nightMode.length).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// GOALS.md
// ---------------------------------------------------------------------------

const SAMPLE_GOALS = `## Bottleneck
Waiting on API credentials

## Goals
- [ ] Set up CI pipeline
- [x] Write unit tests
- [ ] Deploy staging

## Updated
2025-01-15
`;

describe('parseGoalsMd / serializeGoalsMd', () => {
  it('extracts goals fields correctly', () => {
    const { fields } = parseGoalsMd(SAMPLE_GOALS);
    expect(fields.bottleneck).toBe('Waiting on API credentials');
    expect(fields.goals).toContain('Set up CI pipeline');
    expect(fields.goals).toContain('[x] Write unit tests');
  });

  it('round-trips goals without edits', () => {
    const { fields, parsed } = parseGoalsMd(SAMPLE_GOALS);
    const output = serializeGoalsMd(fields, parsed);
    expect(output).toBe(SAMPLE_GOALS);
  });

  it('preserves unknown sections (Updated) through edit', () => {
    const { fields, parsed } = parseGoalsMd(SAMPLE_GOALS);
    fields.bottleneck = 'No blockers';
    const output = serializeGoalsMd(fields, parsed);

    expect(output).toContain('No blockers');
    expect(output).toContain('## Updated');
    expect(output).toContain('2025-01-15');
  });
});
