import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scanSkillsDir, isDirEntry } from '../../../src/cli/list-skills';

function createSkillFile(dir: string, name: string, description: string): void {
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`, 'utf-8');
}

describe('list-skills skill discovery', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `list-skills-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('symlinked skill directory', () => {
    it('discovers a symlinked skill directory pointing to a real dir', () => {
      const targetDir = join(tmp, 'real-skill');
      mkdirSync(targetDir);
      createSkillFile(targetDir, 'linked-skill', 'A symlinked skill');

      const skillsDir = join(tmp, 'skills');
      mkdirSync(skillsDir);
      symlinkSync(targetDir, join(skillsDir, 'linked-skill'));

      const discovered: string[] = [];
      const entries = readdirSync(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (isDirEntry(entry, skillsDir)) {
          const skillFile = join(skillsDir, entry.name, 'SKILL.md');
          if (existsSync(skillFile)) discovered.push(entry.name);
        }
      }

      expect(discovered).toContain('linked-skill');
    });

    it('skips a dangling symlink without crashing', () => {
      const skillsDir = join(tmp, 'skills');
      mkdirSync(skillsDir);
      symlinkSync('/nonexistent/path', join(skillsDir, 'dangling-skill'));

      const discovered: string[] = [];
      const entries = readdirSync(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (isDirEntry(entry, skillsDir)) {
          const skillFile = join(skillsDir, entry.name, 'SKILL.md');
          if (existsSync(skillFile)) discovered.push(entry.name);
        }
      }

      expect(discovered).not.toContain('dangling-skill');
    });

    it('skips a symlink to a file (not a directory)', () => {
      const skillsDir = join(tmp, 'skills');
      mkdirSync(skillsDir);
      const fileTarget = join(tmp, 'some-file.txt');
      writeFileSync(fileTarget, 'not a dir', 'utf-8');
      symlinkSync(fileTarget, join(skillsDir, 'link-to-file'));

      const discovered: string[] = [];
      const entries = readdirSync(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (isDirEntry(entry, skillsDir)) {
          const skillFile = join(skillsDir, entry.name, 'SKILL.md');
          if (existsSync(skillFile)) discovered.push(entry.name);
        }
      }

      expect(discovered).not.toContain('link-to-file');
    });
  });

  describe('scan both skills/ and .claude/skills/ locations', () => {
    it('discovers skill in .claude/skills/', () => {
      const agentDir = join(tmp, 'agent');
      mkdirSync(agentDir);
      const claudeSkills = join(agentDir, '.claude', 'skills', 'test-skill');
      mkdirSync(claudeSkills, { recursive: true });
      createSkillFile(claudeSkills, 'test-skill', 'Found via .claude/skills');

      const skills = scanSkillsDir(join(agentDir, '.claude', 'skills'), 'agent');
      expect(skills.map(s => s.name)).toContain('test-skill');
    });

    it('dedup prefers skills/ over .claude/skills/ on name conflict', () => {
      const agentDir = join(tmp, 'agent');
      mkdirSync(agentDir);

      const skillsPath = join(agentDir, 'skills', 'dup-skill');
      mkdirSync(skillsPath, { recursive: true });
      createSkillFile(skillsPath, 'dup-skill', 'From skills/');

      const claudeSkillsPath = join(agentDir, '.claude', 'skills', 'dup-skill');
      mkdirSync(claudeSkillsPath, { recursive: true });
      createSkillFile(claudeSkillsPath, 'dup-skill', 'From .claude/skills/');

      const skillMap = new Map<string, string>();
      for (const sp of [join(agentDir, '.claude', 'skills'), join(agentDir, 'skills')]) {
        if (!existsSync(sp)) continue;
        for (const skill of scanSkillsDir(sp, 'agent')) {
          skillMap.set(skill.name, sp);
        }
      }

      expect(skillMap.get('dup-skill')).toBe(join(agentDir, 'skills'));
    });
  });
});