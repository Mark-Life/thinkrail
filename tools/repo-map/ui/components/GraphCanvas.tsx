import {
	type ReactNode,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { Icon } from "./Icons";

const MIN_SCALE = 0.3;
const MAX_SCALE = 1.6;
const MIN_AUTO_FIT_SCALE = 0.65;
const FIT_MARGIN = 12;
const WHEEL_ZOOM_RATE = 0.002;

interface View {
	x: number;
	y: number;
	scale: number;
}

export interface GraphCanvasHandle {
	ensureVisible: (rect: { x: number; y: number; width: number; height: number }) => void;
	focusViewport: () => void;
}

function clampScale(scale: number) {
	return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

function fitView(input: {
	viewport: { width: number; height: number };
	content: { width: number; height: number };
	anchor?: { x: number; y: number } | undefined;
	minScale: number;
}): View {
	const { viewport, content, anchor, minScale } = input;
	const available = {
		width: Math.max(1, viewport.width - FIT_MARGIN * 2),
		height: Math.max(1, viewport.height - FIT_MARGIN * 2),
	};
	const exact = Math.min(available.width / content.width, available.height / content.height, 1);
	const scale = Math.max(minScale, exact);
	const fitsWidth = content.width * scale <= available.width;
	const fitsHeight = content.height * scale <= available.height;
	const center = {
		x: (viewport.width - content.width * scale) / 2,
		y: (viewport.height - content.height * scale) / 2,
	};
	return {
		scale,
		x: fitsWidth || !anchor ? center.x : viewport.width / 2 - anchor.x * scale,
		y: fitsHeight || !anchor ? center.y : viewport.height / 2 - anchor.y * scale,
	};
}

export function GraphCanvas(props: {
	content: { width: number; height: number };
	fitKey: string;
	anchor?: { x: number; y: number } | undefined;
	children: ReactNode;
	ref?: React.Ref<GraphCanvasHandle>;
	label: string;
}) {
	const { content, fitKey, anchor } = props;
	const viewportRef = useRef<HTMLDivElement>(null);
	const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
	const [panning, setPanning] = useState(false);
	const viewRef = useRef(view);
	viewRef.current = view;
	const contentRef = useRef(content);
	contentRef.current = content;
	const anchorRef = useRef(anchor);
	anchorRef.current = anchor;

	const fit = useCallback((minScale: number) => {
		const element = viewportRef.current;
		if (!element || contentRef.current.width === 0) return;
		const rect = element.getBoundingClientRect();
		setView(
			fitView({
				viewport: { width: rect.width, height: rect.height },
				content: contentRef.current,
				anchor: anchorRef.current,
				minScale,
			}),
		);
	}, []);

	const userMoved = useRef(false);
	const fittedKey = useRef<string | undefined>(undefined);
	useLayoutEffect(() => {
		if (fittedKey.current === fitKey) return;
		fittedKey.current = fitKey;
		userMoved.current = false;
		fit(MIN_AUTO_FIT_SCALE);
	});

	useEffect(() => {
		const element = viewportRef.current;
		if (!element) return;
		const observer = new ResizeObserver(() => {
			if (!userMoved.current) fit(MIN_AUTO_FIT_SCALE);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [fit]);

	const zoomAt = useCallback((input: { factor: number; x: number; y: number }) => {
		setView((current) => {
			const scale = clampScale(current.scale * input.factor);
			const ratio = scale / current.scale;
			return {
				scale,
				x: input.x - (input.x - current.x) * ratio,
				y: input.y - (input.y - current.y) * ratio,
			};
		});
	}, []);

	useEffect(() => {
		const element = viewportRef.current;
		if (!element) return;
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			userMoved.current = true;
			if (event.ctrlKey || event.metaKey) {
				const rect = element.getBoundingClientRect();
				zoomAt({
					factor: Math.exp(-event.deltaY * WHEEL_ZOOM_RATE * 4),
					x: event.clientX - rect.left,
					y: event.clientY - rect.top,
				});
				return;
			}
			setView((current) => ({
				...current,
				x: current.x - event.deltaX,
				y: current.y - event.deltaY,
			}));
		};
		let drag: { pointer: number; x: number; y: number } | undefined;
		const onPointerDown = (event: PointerEvent) => {
			if (event.button !== 0 || !(event.target instanceof Element)) return;
			if (event.target.closest("a,button")) return;
			userMoved.current = true;
			drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
			element.setPointerCapture(event.pointerId);
			setPanning(true);
		};
		const onPointerMove = (event: PointerEvent) => {
			if (!drag || drag.pointer !== event.pointerId) return;
			const dx = event.clientX - drag.x;
			const dy = event.clientY - drag.y;
			drag = { ...drag, x: event.clientX, y: event.clientY };
			setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
		};
		const onPointerUp = () => {
			drag = undefined;
			setPanning(false);
		};
		element.addEventListener("wheel", onWheel, { passive: false });
		element.addEventListener("pointerdown", onPointerDown);
		element.addEventListener("pointermove", onPointerMove);
		element.addEventListener("pointerup", onPointerUp);
		element.addEventListener("pointercancel", onPointerUp);
		return () => {
			element.removeEventListener("wheel", onWheel);
			element.removeEventListener("pointerdown", onPointerDown);
			element.removeEventListener("pointermove", onPointerMove);
			element.removeEventListener("pointerup", onPointerUp);
			element.removeEventListener("pointercancel", onPointerUp);
		};
	}, [zoomAt]);

	useImperativeHandle(
		props.ref,
		() => ({
			ensureVisible: (rect) => {
				const element = viewportRef.current;
				if (!element) return;
				const bounds = element.getBoundingClientRect();
				const margin = 32;
				setView((current) => {
					const left = rect.x * current.scale + current.x;
					const right = (rect.x + rect.width) * current.scale + current.x;
					const top = rect.y * current.scale + current.y;
					const bottom = (rect.y + rect.height) * current.scale + current.y;
					let { x, y } = current;
					if (left < margin) x += margin - left;
					else if (right > bounds.width - margin) x -= right - bounds.width + margin;
					if (top < margin) y += margin - top;
					else if (bottom > bounds.height - margin) y -= bottom - bounds.height + margin;
					return { ...current, x, y };
				});
			},
			focusViewport: () => viewportRef.current?.focus(),
		}),
		[],
	);

	const zoomCenter = (factor: number) => {
		const element = viewportRef.current;
		if (!element) return;
		const rect = element.getBoundingClientRect();
		userMoved.current = true;
		zoomAt({ factor, x: rect.width / 2, y: rect.height / 2 });
	};

	return (
		<div className={panning ? "graph-viewport graph-panning" : "graph-viewport"} ref={viewportRef}>
			<section
				className={panning ? "graph-layer" : "graph-layer graph-layer-settle"}
				aria-label={props.label}
				style={{
					transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
					width: content.width,
					height: content.height,
				}}
			>
				{props.children}
			</section>
			<div className="graph-controls">
				<button
					type="button"
					className="icon-button"
					title="Zoom in"
					aria-label="Zoom in"
					onClick={() => zoomCenter(1.2)}
				>
					<Icon name="plus" />
				</button>
				<span className="graph-zoom" title="Zoom level">
					{Math.round(view.scale * 100)}%
				</span>
				<button
					type="button"
					className="icon-button"
					title="Zoom out"
					aria-label="Zoom out"
					onClick={() => zoomCenter(1 / 1.2)}
				>
					<Icon name="minus" />
				</button>
				<button
					type="button"
					className="icon-button"
					title="Fit to view"
					aria-label="Fit to view"
					onClick={() => fit(MIN_SCALE)}
				>
					<Icon name="fit" />
				</button>
			</div>
		</div>
	);
}
