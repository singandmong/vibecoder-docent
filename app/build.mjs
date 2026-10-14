import { build } from "esbuild";
import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
// 본문 글꼴 Pretendard(OFL)를 패키지에 넣는다. 실행 중 CDN은 쓰지 않는다 (ADR 0015).
await copyFile(new URL("node_modules/pretendard/dist/web/variable/woff2/PretendardVariable.woff2", root), new URL("app/assets/PretendardVariable.woff2", root));
await copyFile(new URL("node_modules/pretendard/dist/LICENSE.txt", root), new URL("app/assets/Pretendard-LICENSE.txt", root));

await build({
  absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
  entryPoints: ["app/markdown.jsx"],
  outfile: "app/assets/docent-markdown.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  legalComments: "eof",
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
});

// 터미널 강조 보정(ADR 0065). 웹과 같은 remark 파서를 터미널 런타임 경로에서 쓰려고 devDependency를 미리 묶어 둔다.
await build({
  absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
  entryPoints: ["app/terminal-cjk-src.mjs"],
  outfile: "app/assets/terminal-cjk.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["es2022"],
  minify: true,
  legalComments: "none",
  logLevel: "info",
});
