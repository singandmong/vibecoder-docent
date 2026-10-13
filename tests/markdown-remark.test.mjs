import assert from "node:assert/strict";
import test from "node:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { docentRemarkPlugins } from "../app/markdown-remark.mjs";

// 웹 화면(app/markdown.jsx)이 Streamdown에 넘기는 것과 같은 플러그인 목록으로 mdast를 만든다.
function parse(markdown) {
  const processor = unified().use(remarkParse);
  for (const plugin of docentRemarkPlugins()) processor.use(...(Array.isArray(plugin) ? plugin : [plugin]));
  return processor.runSync(processor.parse(markdown));
}

function strongTexts(tree) {
  const found = [];
  const text = (node) => (node.value ?? "") + (node.children ?? []).map(text).join("");
  const visit = (node) => {
    if (node.type === "strong") found.push(text(node));
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return found;
}

function literalStars(tree) {
  let stars = 0;
  const visit = (node) => {
    if (node.type === "text") stars += (node.value.match(/\*/g) ?? []).length;
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return stars;
}

test("web markdown pipeline bolds ** next to Hangul when CommonMark flanking would not (ADR 0061)", () => {
  const cases = [
    ["**`안녕하세요`**를 확인하세요", "안녕하세요"],
    ["**\"문장\"**을 읽습니다", "\"문장\""],
    ["**(괄호)**는 따로 둡니다", "(괄호)"],
    ["**안녕.**하세요", "안녕."],
    ["한글**\"문장\"**을 읽습니다", "\"문장\""],
  ];
  for (const [source, bold] of cases) {
    const tree = parse(source);
    assert.deepEqual(strongTexts(tree), [bold], source);
    assert.equal(literalStars(tree), 0, source);
  }
});

test("web markdown pipeline keeps ASCII emphasis and code untouched", () => {
  const ascii = parse("a**b**c");
  assert.deepEqual(strongTexts(ascii), ["b"]);
  assert.equal(literalStars(ascii), 0);
  const code = parse("`**안녕.**하세요`");
  assert.deepEqual(strongTexts(code), []);
  const inline = code.children[0].children[0];
  assert.equal(inline.type, "inlineCode");
  assert.equal(inline.value, "**안녕.**하세요");
  const fence = parse("```\n**안녕.**하세요\n```");
  assert.deepEqual(strongTexts(fence), []);
  assert.equal(fence.children[0].value, "**안녕.**하세요");
});
