import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

const TOKEN = "fixture-access-token";

const RpcBodySchema = Type.Object({
	id: Type.Optional(Type.Union([Type.String(), Type.Number()])),
	method: Type.Optional(Type.String()),
	params: Type.Optional(Type.Object({ protocolVersion: Type.Optional(Type.String()) })),
});
const RegistrationSchema = Type.Record(Type.String(), Type.Unknown());

function rpc(body: Static<typeof RpcBodySchema>) {
	switch (body.method) {
		case "initialize":
			return {
				protocolVersion: body.params?.protocolVersion ?? "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "oauth-fixture", version: "1.0.0" },
			};
		case "tools/list":
			return {
				tools: [
					{
						name: "whoami",
						description: "Report the signed-in user",
						inputSchema: { type: "object", properties: {} },
						annotations: { readOnlyHint: true },
					},
				],
			};
		case "tools/call":
			return { content: [{ type: "text", text: "fixture-user" }] };
		default:
			return {};
	}
}

export function startOAuthMcpFixture(): {
	url: string;
	tokenRequests: () => number;
	stop: () => void;
} {
	let tokenRequests = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const { pathname, origin } = new URL(request.url);
			const json = (value: unknown, status = 200) => Response.json(value, { status });
			if (pathname.startsWith("/.well-known/oauth-protected-resource")) {
				return json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
			}
			if (pathname === "/.well-known/oauth-authorization-server") {
				return json({
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					registration_endpoint: `${origin}/register`,
					response_types_supported: ["code"],
					grant_types_supported: ["authorization_code", "refresh_token"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["none"],
				});
			}
			if (pathname === "/register") {
				const metadata: unknown = await request.json();
				if (!Check(RegistrationSchema, metadata)) return new Response(null, { status: 400 });
				return json(
					{ ...metadata, client_id: "fixture-client", token_endpoint_auth_method: "none" },
					201,
				);
			}
			if (pathname === "/token") {
				tokenRequests++;
				return json({
					access_token: TOKEN,
					token_type: "Bearer",
					expires_in: 3600,
					refresh_token: "fixture-refresh",
				});
			}
			if (pathname !== "/mcp") return new Response("not found", { status: 404 });
			if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
				return new Response("unauthorized", {
					status: 401,
					headers: {
						"WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
					},
				});
			}
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const body: unknown = await request.json();
			if (!Check(RpcBodySchema, body)) return new Response(null, { status: 400 });
			if (body.id === undefined) return new Response(null, { status: 202 });
			return json({ jsonrpc: "2.0", id: body.id, result: rpc(body) });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/mcp`,
		tokenRequests: () => tokenRequests,
		stop: () => server.stop(true),
	};
}
