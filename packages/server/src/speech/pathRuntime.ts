import { compile, map, obj, unknown } from "@earendil-works/pi-schema";
import { runBounded } from "../subprocess";

export interface PathRuntime {
	bin: string;
	version: string;
	backend: string;
}

const VERSION_TIMEOUT_MS = 10_000;
/** `doctor` initializes every compute device; Metal took 13 s on an idle M-series Mac. */
const DOCTOR_TIMEOUT_MS = 30_000;

export function compatibleVersion(reported: string, pinned: string): string | null {
	const found = /(\d+)\.(\d+)\.(\d+)/.exec(reported);
	const want = /^(\d+)\.(\d+)\./.exec(pinned);
	if (!found || !want) return null;
	return found[1] === want[1] && found[2] === want[2]
		? `${found[1]}.${found[2]}.${found[3]}`
		: null;
}

const DoctorReport = compile(obj({ features: map(unknown()) }, { open: true }));

export function backendFromDoctor(out: string): string {
	let report: unknown;
	try {
		report = JSON.parse(out);
	} catch {
		return "cpu";
	}
	if (!DoctorReport.check(report)) return "cpu";
	const { features } = report;
	return (
		["cuda", "metal", "vulkan"].find((backend) => features[`backend_${backend}`] === true) ?? "cpu"
	);
}

export async function probePathRuntime(pinnedVersion: string): Promise<PathRuntime | null> {
	const bin = Bun.which("nemo-speech", { PATH: process.env.PATH ?? "" });
	if (!bin) return null;
	const versionRun = await runBounded([bin, "--version"], { timeoutMs: VERSION_TIMEOUT_MS });
	if (!versionRun.ok) return null;
	const version = compatibleVersion(versionRun.out, pinnedVersion);
	if (!version) return null;
	const doctor = await runBounded([bin, "doctor", "--json"], { timeoutMs: DOCTOR_TIMEOUT_MS });
	return { bin, version, backend: doctor.ok ? backendFromDoctor(doctor.out) : "cpu" };
}
