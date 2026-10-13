import React from "react";
import { createRoot } from "react-dom/client";
import { Streamdown } from "streamdown";
import { docentRemarkPlugins } from "./markdown-remark.mjs";
import "./markdown.css";

const mounts = new Map();
const plainTags = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "strong", "em", "del", "pre", "code", "table", "thead", "tbody", "tr", "th", "td", "hr", "br"];
const plain = Object.fromEntries(plainTags.map((tag) => [tag, ({ children, start, align, className }) => React.createElement(tag, { ...(className ? { className } : {}), ...(tag === "ol" && start ? { start } : {}), ...(align ? { style: { textAlign: align } } : {}) }, children)]));

function safeHref(value) {
  if (typeof value !== "string" || /[\u0000-\u0020\u007f]/.test(value)) return undefined;
  try {
    const url = new URL(value, window.location.href);
    return ["https:", "http:", "mailto:"].includes(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}

// Streamdown은 remark 플러그인의 함수 이름과 옵션(JSON)으로 처리기를 캐시한다.
// 용어 목록을 클로저에 담으면 처음 만든 처리기의 용어가 다른 답에도 재사용되므로, 반드시 옵션으로 넘긴다.
function docentProse({ names = [] } = {}) {
  return (tree) => {
    // 같은 용어는 답마다 처음 한 번만 링크한다.
    const linked = new Set();
    const visit = (node) => {
      if (["link", "linkReference", "code", "inlineCode", "html", "image", "imageReference"].includes(node.type)) return;
      // 굵은 글씨만 있는 문단(예: "**질문의 선택지**")은 소제목처럼 쓰인다. 아래 본문과 붙이고 앞 묶음과는 띄운다.
      if (node.type === "paragraph" && node.children?.[0]?.type === "strong" && node.children.slice(1).every((child) => child.type === "text" && /^\s*[:：]?\s*$/.test(child.value))) {
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, className: ["md-lead"] } };
      }
      if (node.type === "blockquote") {
        const text = node.children?.[0]?.children?.[0];
        const alert = text?.type === "text" && /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(text.value);
        if (alert) {
          text.value = text.value.slice(alert[0].length);
          node.data = { hProperties: { "data-callout": alert[1].toLowerCase() } };
        }
      }
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !names.length) { visit(child); return [child]; }
        const text = child.value, lower = text.toLowerCase(), parts = [];
        const urls = [...text.matchAll(/(?:https?:\/\/|mailto:|www\.)\S+/gi)].map((match) => [match.index, match.index + match[0].length]);
        let cursor = 0, plainStart = 0;
        while (cursor < text.length) {
          const name = names.find((name) => !linked.has(name) && lower.startsWith(name, cursor)
            && !/[\p{L}\p{N}_]/u.test(text[cursor - 1] ?? "")
            && !/[A-Za-z0-9_]/.test(text[cursor + name.length] ?? "")
            && !urls.some(([start, end]) => cursor < end && cursor + name.length > start));
          if (!name) { cursor++; continue; }
          if (plainStart < cursor) parts.push({ type: "text", value: text.slice(plainStart, cursor) });
          linked.add(name);
          parts.push({ type: "link", url: "#term", data: { hProperties: { "data-docent-term": name } }, children: [{ type: "text", value: text.slice(cursor, cursor + name.length) }] });
          cursor += name.length; plainStart = cursor;
        }
        if (plainStart < text.length) parts.push({ type: "text", value: text.slice(plainStart) });
        return parts;
      });
    };
    visit(tree);
  };
}

function render(entry) {
  const terms = new Map((entry.options.terms ?? []).filter((term) => typeof term?.term === "string" && term.term.length > 1).map((term) => [term.term.toLowerCase(), term]));
  const components = {
    ...plain,
    a: ({ href, children, node }) => {
      const term = terms.get(node?.properties?.["data-docent-term"]);
      if (term) return <button type="button" className="term-link" aria-haspopup="dialog" aria-label={`${term.term} 뜻 보기`} onClick={(event) => entry.options.onTerm?.(term, event.currentTarget)}>{children}</button>;
      const safe = safeHref(href);
      return safe ? <a href={safe} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children}</a> : <span>{children}</span>;
    },
    img: ({ alt }) => <span className="markdown-image-note">{alt ? `이미지: ${alt} (외부 이미지는 불러오지 않아요)` : "외부 이미지는 불러오지 않아요."}</span>,
    blockquote: ({ children, node }) => {
      const kind = node?.properties?.["data-callout"];
      const label = { note: "참고", tip: "도움말", important: "중요", warning: "주의", caution: "주의" }[kind];
      return <blockquote className={label ? `markdown-callout ${kind}` : undefined}>{label && <strong className="callout-title">{label}</strong>}{children}</blockquote>;
    },
  };
  const names = [...terms.keys()].sort((a, b) => b.length - a.length);
  entry.root.render(<Streamdown mode="static" parseIncompleteMarkdown={false} skipHtml rehypePlugins={[]} remarkPlugins={docentRemarkPlugins([[docentProse, { names }]])} components={components} controls={false} linkSafety={{ enabled: false }} urlTransform={(url, key) => key === "src" ? undefined : safeHref(url)}>{entry.text}</Streamdown>);
}

export function mountMarkdown(element, text, options = {}) {
  unmountMarkdown(element);
  element.classList.add("markdown");
  const entry = { root: createRoot(element), text: String(text ?? ""), options };
  mounts.set(element, entry);
  render(entry);
}

export function unmountMarkdown(container) {
  for (const [element, entry] of mounts) {
    if (container === element || container.contains(element)) {
      entry.root.unmount();
      mounts.delete(element);
    }
  }
}
