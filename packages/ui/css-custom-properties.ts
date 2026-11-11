import type {} from "react";

declare module "react" {
	interface CSSProperties {
		[customProperty: `--${string}`]: string | number | undefined;
	}
}
