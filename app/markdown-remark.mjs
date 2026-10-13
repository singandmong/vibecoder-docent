import { defaultRemarkPlugins } from "streamdown";
import { cjk } from "@streamdown/cjk";

// 웹 화면 Markdown의 remark 플러그인 순서(ADR 0061).
// 한글·한자·가나 옆의 강조(`**`, `*`, `~~`)와 URL 경계는 CommonMark 기본 규칙으로는 풀리지 않는다.
// 순서는 Streamdown의 `plugins={{ cjk }}`와 같다: cjk 앞 플러그인은 remark-gfm보다 먼저, 뒤 플러그인은 그 다음이다.
// `extra`(도슨트 용어 링크 등)는 맨 뒤에 둔다.
export function docentRemarkPlugins(extra = []) {
  return [...cjk.remarkPluginsBefore, ...Object.values(defaultRemarkPlugins), ...cjk.remarkPluginsAfter, ...extra];
}
