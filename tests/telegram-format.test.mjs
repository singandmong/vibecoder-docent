import assert from "node:assert/strict";
import test from "node:test";
import { answerMessages, cardText, escapeHtml, sourceText } from "../app/telegram-format.mjs";
import { blockTitle } from "../app/conversations.mjs";

const count = (text, re) => (text.match(re) || []).length;
function assertBalanced(html) {
	assert.equal(count(html, /<b>/g), count(html, /<\/b>/g), `b: ${html.slice(0, 80)}`);
	assert.equal(count(html, /<pre>/g), count(html, /<\/pre>/g), "pre");
	assert.equal(count(html, /<blockquote\b/g), count(html, /<\/blockquote>/g), "blockquote");
	assert.equal(count(html, /<code\b/g), count(html, /<\/code>/g), "code");
}

test("escapeHtml escapes only & < >", () => {
	assert.equal(escapeHtml(`a&b <c> "d" 'e'`), `a&amp;b &lt;c&gt; "d" 'e'`);
});

test("script tags and ampersands in an answer are escaped", () => {
	const [message] = answerMessages("✅ <script>alert(1)</script> & 끝\n\n본문 <img src=x> & 더해요");
	assert.ok(!message.includes("<script>") && !message.includes("<img"));
	assert.ok(message.includes("&lt;script&gt;") && message.includes("&amp;"));
	assertBalanced(message);
});

test("status emoji comes from the status and is omitted when there is none", () => {
	assert.ok(answerMessages("✅ 끝났어요\n\n설명")[0].startsWith("✅ <b>끝났어요</b>\n\n설명"));
	assert.ok(answerMessages("⏳ 하는 중\n\n설명")[0].startsWith("⏳ "));
	assert.ok(answerMessages("⛔ 막혔어요\n\n설명")[0].startsWith("⛔ "));
	const [concept] = answerMessages("캐시는 임시 저장소예요\n\n자주 쓰는 값을 가까이 둬요");
	assert.equal(concept, "<b>캐시는 임시 저장소예요</b>\n\n자주 쓰는 값을 가까이 둬요");
	assert.ok(!/[✅⏳⛔]/u.test(concept));
});

test("a 9000 character answer splits into balanced chunks within 3800", () => {
	const para = (n) => `**문단 ${n}** ${"가나다라 ".repeat(60)}`.trim();
	const body = Array.from({ length: 30 }, (_, i) => para(i)).join("\n\n");
	const raw = `✅ 긴 답이에요\n\n${body}\n\n더 자세히:\n${Array.from({ length: 10 }, (_, i) => `세부 ${i} ${"마바사 ".repeat(80)}`).join("\n\n")}`;
	assert.ok(raw.length > 9000);
	const messages = answerMessages(raw);
	assert.ok(messages.length >= 3);
	for (const message of messages) {
		assert.ok(message.length <= 3800, `length ${message.length}`);
		assertBalanced(message);
	}
});

test("a code fence cut in the middle is closed and reopened", () => {
	const code = Array.from({ length: 400 }, (_, i) => `const value${i} = ${i}; // <tag> & more`).join("\n");
	const messages = answerMessages(`✅ 코드예요\n\n\`\`\`js\n${code}\n\`\`\`\n\n끝이에요`, { max: 1500 });
	assert.ok(messages.length >= 3);
	for (const message of messages) {
		assert.ok(message.length <= 1500);
		assertBalanced(message);
	}
	const withCode = messages.filter((m) => m.includes("<pre>"));
	assert.ok(withCode.length >= 2);
	assert.ok(withCode.every((m) => m.includes('<pre><code class="language-js">') && m.includes("</code></pre>")));
	assert.ok(messages.join("").includes("&lt;tag&gt; &amp; more"));
});

test("a fence without a language uses a bare pre and unclosed fences still close", () => {
	const [message] = answerMessages("✅ 예요\n\n```\nplain <x>\n");
	assert.ok(message.includes("<pre>plain &lt;x&gt;</pre>"));
	assertBalanced(message);
});

test("details become an expandable quote and quote lines inside stay plain", () => {
	const raw = "✅ 결론이에요\n\n> 바깥 인용\n\n더 자세히:\n설명이에요.\n\n> 주의: 안쪽 인용\n> 둘째 줄\n\n| 이름 | 뜻 |\n|---|---|\n| a | b <c> |";
	const messages = answerMessages(raw);
	assert.equal(messages.length, 1);
	const [message] = messages;
	assert.ok(message.includes("<blockquote>바깥 인용</blockquote>"));
	const details = message.slice(message.indexOf("<blockquote expandable>"));
	assert.ok(details.startsWith("<blockquote expandable>더 자세히\n설명이에요."));
	assert.ok(details.includes("&gt; 주의: 안쪽 인용\n&gt; 둘째 줄"));
	assert.equal(count(details, /<blockquote/g), 1);
	assert.ok(details.includes("<pre>| 이름 | 뜻 |\n|---|---|\n| a | b &lt;c&gt; |</pre>"));
	assertBalanced(message);
});

test("headings, bold, inline code and https links convert", () => {
	const [message] = answerMessages("✅ 예요\n\n## 제목이에요\n**굵게** 와 __또 굵게__ 와 `a<b` 코드 [문서](https://example.com/a?x=1&y=2) 끝");
	assert.ok(message.includes("<b>제목이에요</b>"));
	assert.ok(message.includes("<b>굵게</b> 와 <b>또 굵게</b>"));
	assert.ok(message.includes("<code>a&lt;b</code>"));
	assert.ok(message.includes('<a href="https://example.com/a?x=1&amp;y=2">문서</a>'));
	assertBalanced(message);
});

test("javascript: and http: links keep only their text", () => {
	const [message] = answerMessages("✅ 예요\n\n[클릭](javascript:alert(1)) 그리고 [옛 주소](http://example.com) 그리고 [데이터](data:text/html,x)");
	assert.ok(!message.includes("<a"));
	assert.ok(!message.includes("href"));
	assert.ok(message.includes("클릭") && message.includes("옛 주소") && message.includes("데이터"));
});

test("cardText has the kind phrase and the label only, never focus.text", () => {
	const text = "전문이 아주 길게 이어져요 ".repeat(40);
	const label = blockTitle(`${"긴 제목 ".repeat(40)}\n${text}`);
	const html = cardText({ sub: "question", focus: { label, text } });
	assert.ok(html.startsWith("AI가 물어봐요\n"));
	assert.ok(!html.includes(text.slice(0, 30)));
	assert.ok(html.split("\n")[1].length <= 101);
	assert.equal(cardText({ sub: "result", focus: { label: "a<b", text: "x" } }), "작업 결과가 나왔어요\na&lt;b");
	assert.equal(cardText({ sub: "plan", focus: { label: "계획", text: "x" } }), "AI가 계획을 세웠어요\n계획");
	assert.ok(cardText({ sub: "plan", focus: { label: "가".repeat(500), text: "x" } }).split("\n")[1].length <= 101);
});

test("sourceText wraps the raw text in expandable quotes within max", () => {
	assert.deepEqual(sourceText("a <b> & c"), ["<blockquote expandable>a &lt;b&gt; &amp; c</blockquote>"]);
	assert.deepEqual(sourceText("   "), []);
	const raw = Array.from({ length: 300 }, (_, i) => `줄 ${i} ${"원문 ".repeat(20)}`).join("\n");
	const parts = sourceText(raw);
	assert.ok(parts.length >= 2);
	for (const part of parts) {
		assert.ok(part.length <= 3800);
		assert.ok(part.startsWith("<blockquote expandable>") && part.endsWith("</blockquote>"));
		assertBalanced(part);
	}
	const long = sourceText("가".repeat(9000), { max: 2000 });
	assert.ok(long.every((part) => part.length <= 2000));
});

test("no output uses the middle dot or em dash", () => {
	const all = [...answerMessages("✅ 예요\n\n설명\n\n더 자세히:\n세부"), cardText({ sub: "question", focus: { label: "x" } })].join("");
	assert.ok(!all.includes("·") && !all.includes("—"));
});
