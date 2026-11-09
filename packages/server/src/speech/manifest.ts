import { readFileSync } from "node:fs";
import { compile, int, obj, opt, type Schema, type Static, str } from "@earendil-works/pi-schema";
import type { SpeechModel } from "@thinkrail/contracts";

const SafeName = str({ pattern: "^[A-Za-z0-9_-][A-Za-z0-9._-]*$" });

const Artifact = {
	url: str(),
	sha256: str({ pattern: "^[0-9a-f]{64}$" }),
	bytes: int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
};
const RuntimePin = obj({ ...Artifact, root: SafeName, backend: str() }, { open: true });
export type RuntimePin = Static<typeof RuntimePin>;

const ModelPin = obj({ ...Artifact, fileName: SafeName, language: str() }, { open: true });
export type ModelPin = Static<typeof ModelPin>;

const ModelPins: Schema<Record<SpeechModel, ModelPin>> = obj({
	multilingual: ModelPin,
	english: ModelPin,
});

export type SpeechArtifact = Pick<RuntimePin, keyof typeof Artifact>;

const Manifest = obj(
	{
		runtimeVersion: SafeName,
		runtimes: obj({
			"darwin-arm64": opt(RuntimePin),
			"darwin-x64": opt(RuntimePin),
			"linux-x64": opt(RuntimePin),
			"linux-arm64": opt(RuntimePin),
			"win32-x64": opt(RuntimePin),
		}),
		models: ModelPins,
	},
	{ open: true },
);
export type SpeechManifest = Static<typeof Manifest>;
export type SpeechTarget = keyof SpeechManifest["runtimes"];
const ManifestFile = compile(Manifest);

/** Test seam: a JSON file replacing the pinned manifest (e2e serves tiny fixtures from it). */
export const SPEECH_MANIFEST_ENV = "THINKRAIL_SPEECH_MANIFEST";

const RUNTIME_VERSION = "0.3.0";
const RELEASE = `https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v${RUNTIME_VERSION}`;

function runtime(name: string, ext: string, sha256: string, bytes: number, backend: string) {
	const root = `nemo-speech-${RUNTIME_VERSION}-${name}`;
	return { url: `${RELEASE}/${root}.${ext}`, sha256, bytes, root, backend };
}

const PINNED: SpeechManifest = {
	runtimeVersion: RUNTIME_VERSION,
	runtimes: {
		"darwin-arm64": runtime(
			"macos-aarch64-metal",
			"tar.gz",
			"2b972ed8b5dba07492212acf8cb75cbf34ecb141198ffa1997febe84b7c4d9ed",
			7_239_335,
			"metal",
		),
		"darwin-x64": runtime(
			"macos-x86_64-cpu",
			"tar.gz",
			"97e98aa5eb82dffa4f513f26336b5301d792c9fb43f720ac8f9520a0e92ffe3f",
			7_742_012,
			"cpu",
		),
		"linux-x64": runtime(
			"linux-x86_64-cpu",
			"tar.gz",
			"255f12b722ab15b2a38a51cf125d56e3fa97058b528f7e895b39d6a473deb06e",
			9_605_101,
			"cpu",
		),
		"linux-arm64": runtime(
			"linux-aarch64-cpu",
			"tar.gz",
			"56858eaf50d19b05902c043f65d0057352bdc107ae380c41053bfbddfc204bf1",
			9_064_856,
			"cpu",
		),
		"win32-x64": runtime(
			"windows-x86_64-cpu",
			"zip",
			"4ed9740e361e4653f56c3dce7d1e81883a1c8b831c1bd7d01567fff1130b5b05",
			8_694_509,
			"cpu",
		),
	},
	models: {
		multilingual: {
			url: "https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b/resolve/ea30d66debe3740a08b573244286791d423d6b3e/nemotron-3.5-asr-streaming-0.6b.q8_0.gguf",
			sha256: "3fc991d3badad7277c11030a7519832cddaf2057aafed6d4b25147e953a070b1",
			bytes: 742_090_464,
			fileName: "nemotron-3.5-asr-streaming-0.6b.q8_0.gguf",
			language: "auto",
		},
		english: {
			url: "https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b/resolve/ebe59e5a817142986528bbbee5dba8db7b38ed50/nemotron-speech-streaming-en-0.6b.q8_0.gguf",
			sha256: "d9a01898d2a611c8764e23a1c2f45e70bbd5a425dc4de93692ac951dd603812d",
			bytes: 699_872_960,
			fileName: "nemotron-speech-streaming-en-0.6b.q8_0.gguf",
			language: "en-US",
		},
	},
};

/** Windows on Arm runs the x64 build under emulation; NVIDIA ships no CPU arm64 Windows build. */
export function hostTarget(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): SpeechTarget | null {
	if (platform === "darwin") return arch === "arm64" ? "darwin-arm64" : "darwin-x64";
	if (platform === "linux") {
		if (arch === "x64") return "linux-x64";
		if (arch === "arm64") return "linux-arm64";
		return null;
	}
	if (platform === "win32" && (arch === "x64" || arch === "arm64")) return "win32-x64";
	return null;
}

export function parseManifest(value: unknown): SpeechManifest {
	if (ManifestFile.check(value)) return value;
	const problems = ManifestFile.errors(value)
		.slice(0, 3)
		.map((error) => `${error.path} ${error.message}`);
	throw new Error(`speech manifest: ${problems.join("; ")}`);
}

export function loadManifest(
	env: Record<string, string | undefined> = process.env,
): SpeechManifest {
	const override = env[SPEECH_MANIFEST_ENV];
	if (!override) return PINNED;
	return parseManifest(JSON.parse(readFileSync(override, "utf8")));
}
