import { type PointerEvent, useRef } from "react";

const KEY_STEP = 24;

export function ResizeHandle(props: {
	label: string;
	width: number;
	direction: 1 | -1;
	onResize: (width: number) => void;
	onReset: () => void;
}) {
	const { width, direction, onResize } = props;
	const drag = useRef<{ startX: number; startWidth: number } | undefined>(undefined);
	const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
		event.currentTarget.setPointerCapture(event.pointerId);
		drag.current = { startX: event.clientX, startWidth: width };
		document.body.classList.add("is-resizing");
	};
	const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
		if (!drag.current) return;
		onResize(drag.current.startWidth + direction * (event.clientX - drag.current.startX));
	};
	const endDrag = () => {
		drag.current = undefined;
		document.body.classList.remove("is-resizing");
	};
	return (
		<button
			type="button"
			className="resize-handle"
			aria-label={props.label}
			title={`${props.label}: drag, or use the arrow keys. Double-click to reset.`}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={endDrag}
			onPointerCancel={endDrag}
			onDoubleClick={props.onReset}
			onKeyDown={(event) => {
				if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
				event.preventDefault();
				const sign = event.key === "ArrowRight" ? 1 : -1;
				onResize(width + direction * sign * KEY_STEP);
			}}
		/>
	);
}
