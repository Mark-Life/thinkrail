import { type ComponentType, lazy, useState } from "react";

export function preloadedLazy<P extends object>(
	load: () => Promise<{ default: ComponentType<P> }>,
) {
	let pending: Promise<{ default: ComponentType<P> }> | undefined;
	let loaded: ComponentType<P> | undefined;
	const preload = () => {
		if (!pending) {
			pending = load();
			pending.then(
				(module) => {
					loaded = module.default;
				},
				() => undefined,
			);
		}
		return pending;
	};
	const Lazy = lazy(preload);
	function Preloaded(props: P) {
		const [Component] = useState(() => loaded ?? Lazy);
		return <Component {...props} />;
	}
	return Object.assign(Preloaded, { preload });
}
