import { expect, test } from "bun:test";
import { fingerprintMcpEntry } from "./index";

test("fingerprints of stored approvals do not change", () => {
	const pins: [string, unknown, string][] = [
		[
			"srv",
			{
				command: "npx",
				args: ["-y", "s@1"],
				env: { B: "!c", A: `\${A}` },
				toolExposure: { "get_*": "direct", "*": "hidden" },
				enabled: true,
				timeout: 5.5,
				oauth: null,
			},
			"07b25bda6c1f4d379a7be346f64d617093fd1053080798e54f8becd4706bb6b9",
		],
		[
			"http",
			{
				url: "https://x/mcp",
				headers: { Authorization: `Bearer \${T}` },
				exposure: "codemode-deferred",
			},
			"14aa5d61f292960a9ab69404a7d74125e02567ede3f0a44266a958e250beba15",
		],
		[
			"__proto__",
			JSON.parse(
				'{"__proto__":{"command":"x"},"constructor":{"url":"y"},"z":[{"b":1,"a":[null,true]}]}',
			),
			"992852e62b04f3f5728f9cac12af7c9c747dd8ee82cf1895eeb1830b68bf38dc",
		],
		[
			"over",
			{ enabled: false },
			"e4e67033e1c62d1e14457a7f35340237c474f5def25182bf593d96dc6b241d6f",
		],
		[
			"big",
			JSON.parse('{"timeout":1e999}'),
			"bf591ce910ec9183275b6e31bee79f265f8315879f1f9368c223ca1160db8f7b",
		],
		["str", "not an object", "2df0ca4f54ab130c38304f618cd762f0f3e6bbca32a079ed448acf9d9c879ab8"],
		[
			"arr",
			[1, { b: 2, a: 1 }],
			"03ee8e3f4042021fb1f779b8d4a0f7cdf430ff59fd9f1fbb7b4cb286ed069c08",
		],
		["nul", null, "27439441b562aad3c3b421b94d71e09da2f41621faac6d428cf378498dc678e1"],
		["num", 7, "b07eae34e5df9fd6dbd6e6e1778a6a7bc5f59410aac6acc3089e20f7ecc6d80d"],
		["undef", undefined, "d5af67bce350bfe043baa4a60cb8a36d3121fac9ebcb319e9566e9618197740b"],
	];
	for (const [name, entry, fingerprint] of pins) {
		expect(fingerprintMcpEntry(name, entry)).toBe(fingerprint);
	}
});
