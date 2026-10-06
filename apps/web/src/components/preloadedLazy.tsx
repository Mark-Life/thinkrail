import { type ComponentType, lazy, useState } from "react";

export function preloadedLazy<P extends object>(
	load: () => Promise<{ default: ComponentType<P> }>,
) {
	const pending = load();
	let loaded: ComponentType<P> | undefined;
	pending.then(
		(module) => {
			loaded = module.default;
		},
		() => undefined,
	);
	const Lazy = lazy(() => pending);
	return function Preloaded(props: P) {
		const [Component] = useState(() => loaded ?? Lazy);
		return <Component {...props} />;
	};
}
