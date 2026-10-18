import type { FootnoteDefinition, Root as MdastRoot, RootContent } from "mdast";
import type rehypeRaw from "rehype-raw";
import type { Plugin } from "unified";

type HastRoot = Parameters<ReturnType<typeof rehypeRaw>>[0];
export interface StreamingFootnoteAdmissionData {
  streamingFootnoteBlocked?: boolean;
}

type Admission = Readonly<Record<number, boolean>>;
const admissionKey = "streamingFootnoteAdmission";

// 与 micromark-util-normalize-identifier 一致；identifier 保留原始转义及实体。
function normalizeIdentifier(value: string) {
  return value
    .replace(/[\t\n\r ]+/g, " ")
    .replace(/^ | $/g, "")
    .toLowerCase()
    .toUpperCase();
}

// 遵循 micromark-extension-gfm-footnote 的 callData/callEscape；只检查 text
// 节点内起始的候选。候选自身可能跨过 emphasis 等暂时解析出的 inline 节点。
function unresolvedCandidate(
  source: string,
  from: number,
  to: number,
  definitions: ReadonlyMap<string, FootnoteDefinition>,
) {
  const text = source.slice(from, to);
  for (let local = text.indexOf("[^"); local >= 0; local = text.indexOf("[^", local + 2)) {
    const start = from + local;
    let escapes = 0;
    for (let before = start - 1; before >= 0 && source[before] === "\\"; before--) escapes++;
    if (escapes % 2 !== 0) continue;
    let end = start + 2;
    while (end < source.length && end - start - 2 <= 999) {
      const character = source[end]!;
      if (
        character === "[" ||
        character === " " ||
        character === "\t" ||
        character === "\n" ||
        character === "\r"
      )
        break;
      if (character === "]") {
        if (end > start + 2 && !definitions.has(normalizeIdentifier(source.slice(start + 2, end))))
          return true;
        break;
      }
      const next = source[end + 1];
      if (character === "\\" && (next === "[" || next === "]" || next === "\\")) end++;
      end++;
    }
  }
  return false;
}

/** 必须先于 inline buffering 运行；所有可变工作状态仅属于本次 VFile。 */
export const remarkStreamingFootnoteAdmission: Plugin<[], MdastRoot> = () => (tree, file) => {
  const definitions = new Map<string, FootnoteDefinition>();
  const collect = (node: MdastRoot | RootContent) => {
    if (node.type === "footnoteDefinition") {
      const id = normalizeIdentifier(node.identifier);
      if (!definitions.has(id)) definitions.set(id, node);
    }
    if ("children" in node) node.children.forEach(collect);
  };
  collect(tree);
  const source = String(file);
  const seen = new Set<string>();
  const queue: FootnoteDefinition[] = [];
  const admission: Record<number, boolean> = {};
  let blocked = false;
  const visit = (node: MdastRoot | RootContent) => {
    if (node.type === "footnoteDefinition") return;
    if (node.type === "footnoteReference") {
      const id = normalizeIdentifier(node.identifier);
      const definition = definitions.get(id);
      if (definition && !seen.has(id)) {
        seen.add(id);
        queue.push(definition);
        const offset = definition.position?.start.offset;
        if (offset !== undefined) admission[offset] = blocked;
      }
    } else if (!blocked && node.type === "text" && node.value.includes("[^")) {
      const from = node.position?.start.offset;
      const to = node.position?.end.offset;
      if (from !== undefined && to !== undefined)
        blocked = unresolvedCandidate(source, from, to, definitions);
    } else if ("children" in node) node.children.forEach(visit);
  };
  visit(tree);
  // mdast-util-to-hast 先处理全部正文，再按 footnoteOrder 逐条展开 footer；
  // 定义中的新引用追加到同一队尾，重复引用和循环引用不重复展开。
  for (let index = 0; index < queue.length; index++) queue[index]!.children.forEach(visit);
  file.data[admissionKey] = Object.freeze(admission);
};

/** 在 sanitize 之后运行，通过定义的源位置关联生成行，不改变 Markdown 或 DOM 属性。 */
export const rehypeStreamingFootnoteAdmission: Plugin<[], HastRoot> = () => (tree, file) => {
  const admission = file.data[admissionKey] as Admission | undefined;
  for (const section of tree.children) {
    if (section.type !== "element" || section.properties.dataFootnotes === undefined) continue;
    for (const list of section.children) {
      if (list.type !== "element" || list.tagName !== "ol") continue;
      for (const item of list.children) {
        if (item.type !== "element" || item.tagName !== "li") continue;
        const offset = item.position?.start.offset;
        const data: NonNullable<typeof item.data> & StreamingFootnoteAdmissionData = {
          ...item.data,
          streamingFootnoteBlocked: offset !== undefined && admission?.[offset] === true,
        };
        item.data = data;
      }
    }
  }
};
