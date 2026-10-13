// `docent install-omp`: omp 연동 설치 (ADR 0002, 0044, 0057). 프론트매터 + 코어 프롬프트 → omp 서브에이전트 정의, `/docent` 확장 복사.
// 셸 없이 Node 로 설치해 macOS, Linux, Windows PowerShell 에서 같은 명령을 쓴다.
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * `project` 면 지금 폴더의 `.omp/` 에, 아니면 사용자 폴더의 `~/.omp/agent/` 에 설치한다.
 * @returns {Promise<{ agent: string, extension: string }>}
 */
export async function installOmp({ project = false, home = homedir(), cwd = process.cwd() } = {}) {
	const agents = project ? join(cwd, ".omp", "agents") : join(home, ".omp", "agent", "agents");
	const extensions = project ? join(cwd, ".omp", "extensions") : join(home, ".omp", "agent", "extensions");
	await mkdir(agents, { recursive: true });
	await mkdir(extensions, { recursive: true });
	const agent = join(agents, "vibecoder-docent.md");
	const extension = join(extensions, "vibecoder-docent-command.ts");
	const parts = await Promise.all([readFile(join(root, "adapters", "omp", "frontmatter.md")), readFile(join(root, "prompt", "docent.md"))]);
	await writeFile(agent, Buffer.concat(parts));
	await copyFile(join(root, "adapters", "omp", "docent-command.ts"), extension);
	return { agent, extension };
}
