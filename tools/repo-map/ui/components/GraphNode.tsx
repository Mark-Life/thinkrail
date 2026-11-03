import type { CodeSymbol } from "../../core/types";
import { baseName, displayName, kindLabel, shortModule } from "../lib/format";

export function GraphNodeBody(props: {
	symbol: CodeSymbol;
	href: string;
	mark?: string | undefined;
	markClass?: string | undefined;
	onHover?: ((hovering: boolean) => void) | undefined;
	centered?: boolean;
}) {
	const { symbol } = props;
	const name = displayName(symbol);
	const place = `${shortModule(symbol.module)} / ${baseName(symbol.file)}`;
	return (
		<a
			className="node-body"
			href={props.href}
			data-node-id={symbol.id}
			title={`${name}\n${symbol.file}:${symbol.startLine}${symbol.signature ? `\n${symbol.signature}` : ""}`}
			onMouseEnter={() => props.onHover?.(true)}
			onMouseLeave={() => props.onHover?.(false)}
			onFocus={() => props.onHover?.(true)}
			onBlur={() => props.onHover?.(false)}
			aria-current={props.centered ? "true" : undefined}
		>
			<span className="node-line">
				{props.mark ? (
					<span className={`status-mark ${props.markClass ?? ""}`}>{props.mark}</span>
				) : null}
				<span className="kind-badge">{kindLabel(symbol.kind)}</span>
				<span className="node-name">{name}</span>
			</span>
			<span className="node-place">{place}</span>
		</a>
	);
}
