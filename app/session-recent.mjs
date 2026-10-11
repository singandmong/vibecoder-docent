// 세션 목록의 "최근 작업" 한 줄. 모델을 부르지 않고 전사 꼬리에서 고른다.
// 에이전트의 마지막 답은 보통 결론부터 쓰므로 그 첫 문장을 쓰고, 답 글이 없으면 마지막 사용자 요청을 쓴다.

const MAX = 160;

/** Markdown 답에서 화면 한 줄에 쓸 첫 문장. 코드 블록, 표, 구분선은 건너뛴다. */
export function firstSentence(text) {
	let fenced = false;
	for (const raw of String(text ?? "").split("\n")) {
		const line = raw.trim();
		if (/^(```|~~~)/.test(line)) { fenced = !fenced; continue; }
		if (fenced || !line || line.startsWith("|") || /^([-*_=]\s*){3,}$/.test(line) || line.startsWith("<")) continue;
		const plain = line
			.replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, "")
			.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/(\*\*|__|`)/g, "")
			.replace(/\s+/g, " ")
			.trim();
		if (!plain) continue;
		const end = /[.!?。](?=\s|$)/.exec(plain);
		const sentence = end ? plain.slice(0, end.index + 1) : plain;
		return sentence.length > MAX ? `${sentence.slice(0, MAX - 1)}…` : sentence;
	}
	return "";
}

/** 정규화된 이벤트({kind, text}) 목록에서 최근 작업 한 줄. 없으면 "". */
export function recentLine(events) {
	for (const kind of ["assistant", "user"]) {
		for (let i = events.length - 1; i >= 0; i--) {
			if (events[i].kind !== kind) continue;
			const line = firstSentence(events[i].text);
			if (line) return line;
		}
	}
	return "";
}
