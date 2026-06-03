// cortextOS Dashboard - Markdown parser for agent config files
// Round-trip safe: unknown sections preserved through edit cycles

import type {
  MarkdownSection,
  ParsedMarkdown,
  IdentityFields,
  SoulFields,
  GoalsMdFields,
} from '@/lib/types';

// ---------------------------------------------------------------------------
// Generic parser
// ---------------------------------------------------------------------------

/**
 * Split markdown content on heading lines (## , ### , etc.).
 * Returns a ParsedMarkdown with preamble + sections array.
 */
export function parseMarkdown(content: string): ParsedMarkdown {
  if (!content) {
    return { preamble: '', sections: [], raw: '' };
  }

  const raw = content;
  const lines = content.split('\n');
  const sections: MarkdownSection[] = [];

  // Find all heading line indices
  const headingIndices: { index: number; level: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      headingIndices.push({
        index: i,
        level: match[1].length,
        text: match[2],
      });
    }
  }

  // Preamble is everything before the first heading
  const firstHeadingLine = headingIndices.length > 0 ? headingIndices[0].index : lines.length;
  const preamble = lines.slice(0, firstHeadingLine).join('\n');

  // Build sections
  for (let h = 0; h < headingIndices.length; h++) {
    const current = headingIndices[h];
    const nextIndex = h + 1 < headingIndices.length ? headingIndices[h + 1].index : lines.length;

    const sectionLines = lines.slice(current.index, nextIndex);
    const rawSection = sectionLines.join('\n');

    // Content is everything after the heading line
    const contentLines = sectionLines.slice(1);
    const sectionContent = contentLines.join('\n');

    sections.push({
      heading: current.text,
      level: current.level,
      content: sectionContent,
      raw: rawSection,
    });
  }

  return { preamble, sections, raw };
}

/**
 * Reconstruct markdown from a ParsedMarkdown structure.
 * Round-trip safe: serializeMarkdown(parseMarkdown(s)) === s
 */
export function serializeMarkdown(parsed: ParsedMarkdown): string {
  const parts: string[] = [];

  if (parsed.preamble || parsed.sections.length === 0) {
    parts.push(parsed.preamble);
  }

  for (const section of parsed.sections) {
    parts.push(section.raw);
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the trimmed text content of a section by heading name (case-insensitive). */
function getSectionContent(parsed: ParsedMarkdown, ...headings: string[]): string {
  const lowerHeadings = headings.map((h) => h.toLowerCase());
  for (const section of parsed.sections) {
    if (lowerHeadings.includes(section.heading.toLowerCase())) {
      return section.content.trim();
    }
  }
  return '';
}

/**
 * Update a section's content by heading. If found, replaces content;
 * if not found, appends a new section. Returns a new ParsedMarkdown.
 */
function updateSection(
  parsed: ParsedMarkdown,
  heading: string,
  newContent: string,
  level: number = 2,
): ParsedMarkdown {
  const lowerHeading = heading.toLowerCase();
  const sections = parsed.sections.map((s) => {
    if (s.heading.toLowerCase() === lowerHeading) {
      const headingLine = '#'.repeat(s.level) + ' ' + s.heading;
      const newRaw = headingLine + '\n' + newContent;
      return {
        ...s,
        content: newContent,
        raw: newRaw,
      };
    }
    return s;
  });

  // If not found, append
  const found = sections.some((s) => s.heading.toLowerCase() === lowerHeading);
  if (!found && newContent) {
    const prefix = '#'.repeat(level);
    const raw = `${prefix} ${heading}\n${newContent}`;
    sections.push({
      heading,
      level,
      content: newContent,
      raw,
    });
  }

  return { ...parsed, sections };
}

// ---------------------------------------------------------------------------
// IDENTITY.md
// ---------------------------------------------------------------------------

const IDENTITY_MAP: Record<string, string> = {
  name: 'Name',
  role: 'Role',
  emoji: 'Emoji',
  vibe: 'Vibe',
  workStyle: 'Work Style',
};

const IDENTITY_HEADINGS: Record<string, string> = {
  name: 'name',
  role: 'role',
  emoji: 'emoji',
  vibe: 'vibe',
  'work style': 'workStyle',
};

export function parseIdentityMd(
  content: string,
): { fields: IdentityFields; parsed: ParsedMarkdown } {
  const parsed = parseMarkdown(content);
  const fields: IdentityFields = {
    name: '',
    role: '',
    emoji: '',
    vibe: '',
    workStyle: '',
  };

  for (const section of parsed.sections) {
    const key = IDENTITY_HEADINGS[section.heading.toLowerCase()];
    if (key) {
      fields[key] = section.content.trim();
    }
  }

  return { fields, parsed };
}

export function serializeIdentityMd(
  fields: IdentityFields,
  original: ParsedMarkdown,
): string {
  let result = original;
  for (const [fieldKey, heading] of Object.entries(IDENTITY_MAP)) {
    if (fields[fieldKey] !== undefined) {
      result = updateSection(result, heading, fields[fieldKey] + '\n');
    }
  }
  return serializeMarkdown(result);
}

// ---------------------------------------------------------------------------
// SOUL.md
//
// SOUL.md ships in two heading shapes and the parser must round-trip BOTH:
//
//   (a) Explicit shape — one heading per field:
//         ## Autonomy Rules / ## Communication Style
//         ## Day Mode / ## Night Mode / ## Core Truths
//
//   (b) Template shape (what every templates/* SOUL.md actually uses):
//         ## Autonomy Rules
//         ## Day/Night Mode   <- combined, with bold sub-lines:
//             **Day Mode (...):** ...prose...
//             **Night Mode (...):** ...prose...
//         ## Communication     <- not "Communication Style"
//       and NO Core Truths section at all.
//
// The parser adapts to the templates; the templates are never modified
// (agents in the field already have them). Day/Night prose is captured WITH
// its bold label so the embedded time range / {{day_mode_start}} survives a
// round-trip, and so the combined section is updated IN PLACE on save rather
// than spawning orphan duplicate headings.
// ---------------------------------------------------------------------------

// Heading text -> SoulFields key. Synonyms collapse to one canonical field.
const SOUL_HEADINGS: Record<string, string> = {
  autonomy: 'autonomyRules',
  'autonomy rules': 'autonomyRules',
  communication: 'communicationStyle',
  'communication style': 'communicationStyle',
  'day mode': 'dayMode',
  'night mode': 'nightMode',
  'core truths': 'coreTruths',
};

// Combined heading variants that carry BOTH dayMode and nightMode as bold
// sub-lines inside a single section.
const COMBINED_DAYNIGHT_HEADINGS = new Set(['day/night mode', 'day / night mode']);

/**
 * Extract the Day Mode / Night Mode bold sub-blocks from a combined
 * "Day/Night Mode" section's content.
 *
 * A sub-block is the line beginning `**Day Mode` (resp. `**Night Mode`)
 * through to (but not including) the start of the next sub-block. The bold
 * label is captured along with the prose so the embedded time range survives.
 */
const DAY_LABEL_RE = /^\*\*\s*Day Mode\b/i;
const NIGHT_LABEL_RE = /^\*\*\s*Night Mode\b/i;

interface DayNightSegments {
  /** Lines before the first labelled block (verbatim, preserved on save). */
  preamble: string[];
  /** Day Mode block lines (label + prose), or null if absent. */
  dayLines: string[] | null;
  /** Night Mode block lines (label + prose), or null if absent. */
  nightLines: string[] | null;
  /** Order the two blocks appear in, so we can re-emit them faithfully. */
  order: ('day' | 'night')[];
}

/**
 * Segment a combined "Day/Night Mode" section's content into its Day block,
 * Night block, and any surrounding lines. Each block runs from its bold label
 * line up to (not including) the next block's label. Lines before the first
 * label are preamble and are preserved verbatim — nothing in the section is
 * discarded on save.
 */
function segmentDayNight(content: string): DayNightSegments {
  const lines = content.split('\n');
  const preamble: string[] = [];
  let dayLines: string[] | null = null;
  let nightLines: string[] | null = null;
  const order: ('day' | 'night')[] = [];
  let current: 'day' | 'night' | null = null;

  for (const line of lines) {
    if (DAY_LABEL_RE.test(line)) {
      dayLines = [];
      if (!order.includes('day')) order.push('day');
      current = 'day';
    } else if (NIGHT_LABEL_RE.test(line)) {
      nightLines = [];
      if (!order.includes('night')) order.push('night');
      current = 'night';
    }

    if (current === 'day' && dayLines) dayLines.push(line);
    else if (current === 'night' && nightLines) nightLines.push(line);
    else preamble.push(line);
  }

  return { preamble, dayLines, nightLines, order };
}

/** Extract trimmed Day/Night field values from a combined section. */
function splitDayNight(content: string): { dayMode: string; nightMode: string } {
  const { dayLines, nightLines } = segmentDayNight(content);
  return {
    dayMode: dayLines ? dayLines.join('\n').trim() : '',
    nightMode: nightLines ? nightLines.join('\n').trim() : '',
  };
}

export function parseSoulMd(
  content: string,
): { fields: SoulFields; parsed: ParsedMarkdown } {
  const parsed = parseMarkdown(content);
  const fields: SoulFields = {
    autonomyRules: '',
    communicationStyle: '',
    dayMode: '',
    nightMode: '',
    coreTruths: '',
  };

  for (const section of parsed.sections) {
    const lower = section.heading.toLowerCase();

    if (COMBINED_DAYNIGHT_HEADINGS.has(lower)) {
      const { dayMode, nightMode } = splitDayNight(section.content);
      if (dayMode) fields.dayMode = dayMode;
      if (nightMode) fields.nightMode = nightMode;
      continue;
    }

    const key = SOUL_HEADINGS[lower];
    if (key) {
      fields[key] = section.content.trim();
    }
  }

  return { fields, parsed };
}

/**
 * Locate the existing section (case-insensitive) whose heading maps to the
 * given canonical field, returning its heading text — so updates reuse the
 * file's actual heading and never spawn a duplicate with a different label.
 */
function findSoulHeading(
  parsed: ParsedMarkdown,
  fieldKey: string,
): string | undefined {
  for (const s of parsed.sections) {
    if (SOUL_HEADINGS[s.heading.toLowerCase()] === fieldKey) {
      return s.heading;
    }
  }
  return undefined;
}

/**
 * Rebuild a combined Day/Night Mode section's content, substituting ONLY the
 * Day and Night block bodies and preserving everything else — preamble, the
 * block ordering, and the original separator whitespace — so an edit to one
 * field never reflows untouched text or silently drops other content in the
 * section.
 */
function rebuildDayNight(
  dayMode: string,
  nightMode: string,
  originalContent: string,
): string {
  const seg = segmentDayNight(originalContent);
  // Use the field values verbatim — an empty field means the operator cleared
  // it and that block must disappear (no falling back to the old content).
  const dayBlock = dayMode.trim();
  const nightBlock = nightMode.trim();

  // Preserve the original separator between the two blocks (blank line vs.
  // none) by inspecting ONLY the whitespace immediately preceding the Night
  // label — a blank paragraph elsewhere inside the Day block must not force a
  // spaced layout. Line-anchored (multiline) search finds the label wherever
  // it sits, not just at offset 0.
  const nightIdx = originalContent.search(/^\*\*\s*Night Mode\b/im);
  let separator = '\n\n';
  if (nightIdx > 0) {
    const before = originalContent.slice(0, nightIdx);
    // A blank line directly above the Night label ⇒ spaced layout.
    separator = /\n[ \t]*\n[ \t]*$/.test(before) ? '\n\n' : '\n';
  }

  // Canonical Day→Night order: emit Day first, then Night. (Templates always
  // list Day before Night; canonicalizing keeps a consistent, predictable
  // layout and means a newly-added block lands in the expected position.)
  const emitted: string[] = [];
  if (dayBlock) emitted.push(dayBlock);
  if (nightBlock) emitted.push(nightBlock);

  // Reattach any preamble lines verbatim. For a freshly-created section (no
  // original content), open with a blank line to match the shipped template
  // layout (## Day/Night Mode\n\n**Day Mode...). Otherwise replay the leading
  // blank line only if the source had one.
  const preamble = seg.preamble.join('\n');
  const isFresh = originalContent === '';
  const leading =
    isFresh || (/^\n/.test(originalContent) && !preamble.trim()) ? '\n' : '';
  const head = preamble.trim() ? preamble.replace(/\n+$/, '') + '\n\n' : leading;

  return head + emitted.join(separator) + '\n';
}

// Default heading labels used only when a field has no existing section and
// the user supplied content (genuinely new section, safe to append). Labels
// match the template shape so a fresh section doesn't look foreign next to
// the template's own headings (e.g. "Communication", not "Communication Style").
const SOUL_DEFAULT_HEADINGS: Record<string, string> = {
  autonomyRules: 'Autonomy Rules',
  communicationStyle: 'Communication',
  dayMode: 'Day Mode',
  nightMode: 'Night Mode',
  coreTruths: 'Core Truths',
};

export function serializeSoulMd(
  fields: SoulFields,
  original: ParsedMarkdown,
): string {
  let result = original;

  // Is Day/Night carried as one combined section in the source file?
  const combinedSection = original.sections.find((s) =>
    COMBINED_DAYNIGHT_HEADINGS.has(s.heading.toLowerCase()),
  );
  const combinedHeading = combinedSection?.heading;
  // What did the combined section originally yield, so we can detect whether
  // the operator actually edited Day/Night and avoid reflowing untouched text
  // (templates vary: blank line vs. no blank line between the bold sub-lines).
  const originalDayNight = combinedSection
    ? splitDayNight(combinedSection.content)
    : { dayMode: '', nightMode: '' };

  // Does the file carry explicit single-mode sections (## Day Mode / ## Night
  // Mode)? If neither those nor a combined section exist, a fresh save should
  // emit ONE canonical "## Day/Night Mode" section (template shape), not two
  // orphan single-mode headings.
  const hasExplicitDay = findSoulHeading(original, 'dayMode') !== undefined;
  const hasExplicitNight = findSoulHeading(original, 'nightMode') !== undefined;
  const useCanonicalCombined =
    !combinedHeading && !hasExplicitDay && !hasExplicitNight;

  for (const fieldKey of Object.keys(SOUL_DEFAULT_HEADINGS)) {
    const value = fields[fieldKey];
    if (value === undefined) continue;

    // Day/Night fields fold back into the combined section when present, or
    // into a freshly-created canonical combined section when the file has no
    // day/night sections at all.
    if (
      (fieldKey === 'dayMode' || fieldKey === 'nightMode') &&
      (combinedHeading || useCanonicalCombined)
    ) {
      // Handle the pair once, when processing dayMode; skip nightMode.
      if (fieldKey === 'nightMode') continue;
      const dayMode = fields.dayMode ?? '';
      const nightMode = fields.nightMode ?? '';

      if (combinedHeading) {
        // Unchanged from the source: leave the section's raw text exactly
        // as-is so differing template layouts round-trip losslessly.
        if (
          dayMode.trim() === originalDayNight.dayMode.trim() &&
          nightMode.trim() === originalDayNight.nightMode.trim()
        ) {
          continue;
        }
        const newContent = rebuildDayNight(
          dayMode,
          nightMode,
          combinedSection?.content ?? '',
        );
        result = updateSection(result, combinedHeading, newContent);
      } else if (dayMode.trim() || nightMode.trim()) {
        // Fresh file: append one canonical combined section.
        const newContent = rebuildDayNight(dayMode, nightMode, '');
        result = updateSection(result, 'Day/Night Mode', newContent);
      }
      continue;
    }

    // Reuse the file's actual heading if a matching section exists; this is
    // what stops "Communication" gaining an orphan "Communication Style".
    const existing = findSoulHeading(result, fieldKey);
    if (existing) {
      // Skip rewriting sections the operator left untouched so the original
      // raw text (and its exact whitespace) round-trips losslessly.
      const existingSection = result.sections.find((s) => s.heading === existing);
      if (existingSection && existingSection.content.trim() === value.trim()) {
        continue;
      }
      result = updateSection(result, existing, value + '\n');
    } else if (value.trim()) {
      // No matching section and the user typed content: append a new one.
      result = updateSection(result, SOUL_DEFAULT_HEADINGS[fieldKey], value + '\n');
    }
    // No matching section and empty value: do nothing (don't append blanks).
  }

  return serializeMarkdown(result);
}

// ---------------------------------------------------------------------------
// GOALS.md
// ---------------------------------------------------------------------------

const GOALS_HEADINGS: Record<string, string> = {
  bottleneck: 'bottleneck',
  'current bottleneck': 'bottleneck',
  goals: 'goals',
  'active goals': 'goals',
};

export function parseGoalsMd(
  content: string,
): { fields: GoalsMdFields; parsed: ParsedMarkdown } {
  const parsed = parseMarkdown(content);
  const fields: GoalsMdFields = {
    bottleneck: '',
    goals: '',
  };

  for (const section of parsed.sections) {
    const key = GOALS_HEADINGS[section.heading.toLowerCase()];
    if (key) {
      fields[key] = section.content.trim();
    }
  }

  return { fields, parsed };
}

export function serializeGoalsMd(
  fields: GoalsMdFields,
  original: ParsedMarkdown,
): string {
  let result = original;
  if (fields.bottleneck !== undefined) {
    // Try to match existing heading
    const bottleneckHeading =
      original.sections.find((s) => GOALS_HEADINGS[s.heading.toLowerCase()] === 'bottleneck')
        ?.heading ?? 'Bottleneck';
    result = updateSection(result, bottleneckHeading, fields.bottleneck + '\n');
  }
  if (fields.goals !== undefined) {
    const goalsHeading =
      original.sections.find((s) => GOALS_HEADINGS[s.heading.toLowerCase()] === 'goals')
        ?.heading ?? 'Goals';
    result = updateSection(result, goalsHeading, fields.goals + '\n');
  }
  return serializeMarkdown(result);
}
