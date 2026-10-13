// vibecoder-docent: OMP 입력창의 /docent 명령 (ADR 0044).
// 지금 OMP 세션을 Herdr 오른쪽 창의 도슨트 터미널로 바로 연다. 실제 일은 `docent herdr` 가 한다.
// `docent install-omp` 가 ~/.omp/agent/extensions/ 에 복사한다. 이 파일을 고치면 다시 설치한다.
// @ts-nocheck

export default function (pi) {
	pi.registerCommand("docent", {
		description: "도슨트를 Herdr 오른쪽 창에 띄워 지금 세션을 설명받기",
		handler: async (_args, ctx) => {
			if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
				ctx.ui.notify("Herdr 창에서만 쓸 수 있어요. 다른 터미널에서 docent-tui 를 실행하세요.", "error");
				return;
			}
			let file;
			try {
				file = ctx.sessionManager?.getSessionFile?.();
			} catch {
				file = undefined;
			}
			const args = ["herdr", "--cwd", ctx.cwd];
			if (typeof file === "string" && file) args.push("--session-file", file);
			const result = await pi.exec("docent", args, { cwd: ctx.cwd });
			if (result.code === 0) ctx.ui.notify(result.stdout.trim() || "도슨트를 띄웠어요.", "info");
			else ctx.ui.notify((result.stderr || result.stdout).trim() || "도슨트를 띄우지 못했어요. 터미널에서 docent doctor 로 확인하세요.", "error");
		},
	});
}
