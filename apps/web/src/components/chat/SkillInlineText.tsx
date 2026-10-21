import { Children, cloneElement, isValidElement, type ReactNode } from "react";
import type { ServerProviderSkill } from "@t3tools/contracts";
import { formatProviderSkillDisplayName } from "@t3tools/client-runtime/providerSkills";

import { SKILL_CHIP_ICON_SVG } from "../composerInlineChip";
import { ContextChip, ContextChipLabel } from "../ContextChip";

const SKILL_TOKEN_REGEX =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;

type InlineSkill = Pick<ServerProviderSkill, "name" | "displayName">;

/** Shared token/label decisions for live rendering and inert inline layout. */
export function skillInlineMatches(text: string, skills: ReadonlyArray<InlineSkill>) {
  const matches: { start: number; end: number; rawText: string; label: string }[] = [];
  for (const match of text.matchAll(SKILL_TOKEN_REGEX)) {
    const prefix = match[1] ?? "";
    const name = match[2] ?? "";
    const start = (match.index ?? 0) + prefix.length;
    const rawText = `$${name}`;
    const skill = skills.find((candidate) => candidate.name === name);
    if (!skill) {
      continue;
    }

    matches.push({
      start,
      end: (match.index ?? 0) + match[0].length,
      rawText,
      label: formatProviderSkillDisplayName(skill),
    });
  }
  return matches;
}

export function SkillInlineText(props: { text: string; skills: ReadonlyArray<InlineSkill> }) {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of skillInlineMatches(props.text, props.skills)) {
    if (match.start > cursor) nodes.push(props.text.slice(cursor, match.start));
    nodes.push(
      <SkillChip
        key={`${match.start}:${match.rawText.slice(1)}`}
        label={match.label}
        rawText={match.rawText}
      />,
    );
    cursor = match.end;
  }

  if (cursor === 0) {
    return <>{props.text}</>;
  }
  if (cursor < props.text.length) {
    nodes.push(props.text.slice(cursor));
  }
  return <>{nodes}</>;
}

export function renderSkillInlineMarkdownChildren(
  children: ReactNode,
  skills: ReadonlyArray<InlineSkill>,
): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return <SkillInlineText text={child} skills={skills} />;
    }
    if (!isValidElement<{ children?: ReactNode; node?: { tagName?: string } }>(child)) {
      return child;
    }
    // Custom react-markdown components replace the intrinsic type, so also
    // check the hast node they carry.
    const markdownTagName = typeof child.type === "string" ? child.type : child.props.node?.tagName;
    if (markdownTagName === "code" || markdownTagName === "a") {
      return child;
    }
    if (!("children" in child.props)) {
      return child;
    }
    return cloneElement(
      child,
      undefined,
      renderSkillInlineMarkdownChildren(child.props.children, skills),
    );
  });
}

function SkillChip(props: { label: string; rawText: string }) {
  return (
    <ContextChip kind="skill" data-markdown-copy={props.rawText}>
      <SkillChipIcon />
      <ContextChipLabel>{props.label}</ContextChipLabel>
    </ContextChip>
  );
}

/** The skill glyph; the surrounding chip sizes its svg. */
export function SkillChipIcon() {
  return (
    <span
      aria-hidden="true"
      className="contents"
      dangerouslySetInnerHTML={{ __html: SKILL_CHIP_ICON_SVG }}
    />
  );
}
