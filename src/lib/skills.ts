import type { SkillInfo } from "./types";

export type SkillMention = {
  name: string;
  token: string;
  prefix: "$" | "/";
  source: SkillInfo["source"];
  description?: string | null;
  start: number;
  end: number;
};

const SKILL_TOKEN = /(^|[\s([{])([$\/])([A-Za-z0-9][A-Za-z0-9_.-]*)(?=$|[\s.,;:!?)}\]])/g;

export function skillKey(name: string): string {
  return name.trim().toLowerCase();
}

function skillMap(skills: SkillInfo[]): Map<string, SkillInfo> {
  return new Map(skills.map((skill) => [skillKey(skill.name), skill]));
}

export function findSkillMentions(text: string, skills: SkillInfo[]): SkillMention[] {
  const known = skillMap(skills);
  const mentions: SkillMention[] = [];
  SKILL_TOKEN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = SKILL_TOKEN.exec(text))) {
    const [, leading, rawPrefix, rawName] = match;
    const skill = known.get(skillKey(rawName));
    if (!skill) continue;
    const start = match.index + leading.length;
    const token = `${rawPrefix}${rawName}`;
    mentions.push({
      name: skill.name,
      token,
      prefix: rawPrefix as "$" | "/",
      source: skill.source,
      description: skill.description,
      start,
      end: start + token.length,
    });
  }

  return mentions;
}

export function uniqueSkillMentions(mentions: SkillMention[]): SkillMention[] {
  const seen = new Set<string>();
  const unique: SkillMention[] = [];
  for (const mention of mentions) {
    const key = `${mention.prefix}:${skillKey(mention.name)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(mention);
  }
  return unique;
}

export function removeSkillMention(text: string, skills: SkillInfo[], name: string): string {
  const target = skillKey(name);
  const mentions = findSkillMentions(text, skills)
    .filter((mention) => skillKey(mention.name) === target)
    .sort((a, b) => b.start - a.start);

  let next = text;
  for (const mention of mentions) {
    let end = mention.end;
    if (next[end] === " " && next[mention.start - 1] !== " ") {
      end += 1;
    }
    next = `${next.slice(0, mention.start)}${next.slice(end)}`;
  }
  return next;
}

export function findSkillByName(skills: SkillInfo[], name: string): SkillInfo | null {
  const key = skillKey(name);
  return skills.find((skill) => skillKey(skill.name) === key) ?? null;
}

export function skillInvocationToken(
  name: string,
  runtimeId: string | null | undefined,
): string {
  const prefix = runtimeId === "codex" ? "$" : "/";
  return `${prefix}${name}`;
}
