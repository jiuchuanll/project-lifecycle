// DeepSeek Harness skill provider bundle.
//
// This is the DSH-native plugin entry for project-lifecycle. It registers a
// filesystem skill provider over the shared `skills/` directory so the two
// authoritative Skills are discovered without any host-specific Skill copy.
// `cordis.patch.yml` inserts this package as a profile bundle row; the bundle
// root also carries `bin/` and `dist/`, matching the Skills' "ascend two
// directories from SKILL.md" runtime-resolution contract.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

export const name = 'project-lifecycle';
export const inject = ['skills'];

const PROVIDER = 'project-lifecycle';
// `BUNDLED_SKILL_RANK` from `@deepseek-ai/dsh-skill` (a stable public constant);
// declared locally to keep this bundle free of an install-time peer dependency
// on the DSH runtime, so the repository's own `npm ci` surface stays unchanged.
const BUNDLED_SKILL_RANK = 600;
const SKILLS_ROOT = fileURLToPath(new URL('../skills/', import.meta.url));
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;

const frontmatter = (source) => {
  const match = FRONTMATTER.exec(source);
  if (!match) return {};
  const parsed = parseYaml(match[1]);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
};

const stripFrontmatter = (source) => {
  const match = FRONTMATTER.exec(source);
  return match ? source.slice(match[0].length) : source;
};

const readSkill = async (directory) => {
  const path = join(directory, 'SKILL.md');
  const source = await readFile(path, 'utf8');
  const meta = frontmatter(source);
  if (typeof meta.name !== 'string' || typeof meta.description !== 'string') return null;
  return { name: meta.name, description: meta.description, content: stripFrontmatter(source), path };
};

const provider = {
  name: PROVIDER,
  async list() {
    const skills = [];
    const entries = await readdir(SKILLS_ROOT, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = join(SKILLS_ROOT, entry.name);
      let skill;
      try {
        skill = await readSkill(directory);
      } catch {
        continue; // Malformed or missing SKILL.md entries are skipped, not fatal.
      }
      if (!skill) continue;
      skills.push({
        name: skill.name,
        description: skill.description,
        invocation: { modelInvocable: true, userInvocable: true },
        provider: PROVIDER,
        source: 'bundled',
        resourceBase: { kind: 'directory', path: directory },
        rank: BUNDLED_SKILL_RANK,
        locator: directory,
        path: skill.path,
      });
    }
    return skills;
  },
  async get(candidate) {
    const skill = await readSkill(candidate.locator);
    if (!skill) return undefined;
    return {
      name: skill.name,
      description: skill.description,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: PROVIDER,
      source: 'bundled',
      resourceBase: { kind: 'directory', path: candidate.locator },
      content: skill.content,
      path: skill.path,
    };
  },
};

export function apply(ctx) {
  ctx.skills.registerProvider(() => provider);
}
