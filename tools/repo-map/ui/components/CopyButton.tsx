import { useCopy } from "../lib/hooks";
import { Icon } from "./Icons";

export function CopyButton(props: { text: string; label: string }) {
	const { copied, copy } = useCopy();
	return (
		<button
			type="button"
			className="icon-button"
			aria-label={copied ? "Copied" : props.label}
			title={copied ? "Copied" : props.label}
			onClick={() => copy(props.text)}
		>
			<Icon name={copied ? "check" : "copy"} />
		</button>
	);
}
