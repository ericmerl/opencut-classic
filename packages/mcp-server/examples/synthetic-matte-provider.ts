interface ProducerJob {
	protocolVersion: 1;
	source: {
		width: number;
		height: number;
		duration: number;
		fps: number | null;
	};
	outputDirectory: string;
}

const job = (await Bun.stdin.json()) as ProducerJob;
if (job.protocolVersion !== 1) throw new Error("Unsupported protocol version");

const outputPath = `${job.outputDirectory}/synthetic-matte.webm`;
const fps = job.source.fps ?? 30;
const filter = [
	`color=black:s=${job.source.width}x${job.source.height}:r=${fps}:d=${job.source.duration}`,
	"drawbox=x=iw*0.25:y=ih*0.1:w=iw*0.5:h=ih*0.8:color=white:t=fill",
].join(",");
const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
const child = Bun.spawn(
	[
		ffmpeg,
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		filter,
		"-c:v",
		"libvpx-vp9",
		"-pix_fmt",
		"yuv420p",
		"-an",
		"-y",
		outputPath,
	],
	{ stdout: "ignore", stderr: "inherit" },
);
const exitCode = await child.exited;
if (exitCode !== 0) throw new Error(`ffmpeg exited with code ${exitCode}`);

console.log(
	JSON.stringify({
		protocolVersion: 1,
		status: "completed",
		artifact: { path: "synthetic-matte.webm", channel: "red" },
		model: { id: "synthetic-protocol-fixture", version: "1" },
		warnings: ["Synthetic rectangle matte for integration testing only"],
	}),
);
