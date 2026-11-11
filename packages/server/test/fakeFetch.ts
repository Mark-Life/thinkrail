/** A `typeof fetch` stand-in whose every call is answered by `respond`. */
export function fakeFetch(
	respond: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Response | Promise<Response>,
) {
	return Object.assign(
		async (input: Parameters<typeof fetch>[0], init?: RequestInit) => respond(input, init),
		{
			preconnect: fetch.preconnect,
		},
	);
}
