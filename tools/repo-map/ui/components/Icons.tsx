const ICONS = {
	search:
		"M7 2a5 5 0 1 0 3 9l3 3 1-1-3-3a5 5 0 0 0-4-8Zm0 1.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Z",
	copy: "M5 2h7a1 1 0 0 1 1 1v8h-1.5V3.5H5V2ZM3 5h7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm.5 1.5v6h6v-6h-6Z",
	check: "M6.2 11.3 2.8 8l1-1 2.4 2.3 6-6 1 1-7 7Z",
	fit: "M2 6V2h4v1.5H3.5V6H2Zm8-4h4v4h-1.5V3.5H10V2ZM2 10h1.5v2.5H6V14H2v-4Zm10.5 0H14v4h-4v-1.5h2.5V10Z",
	plus: "M7.25 3h1.5v4.25H13v1.5H8.75V13h-1.5V8.75H3v-1.5h4.25V3Z",
	minus: "M3 7.25h10v1.5H3v-1.5Z",
} as const;

export function Icon(props: { name: keyof typeof ICONS }) {
	return (
		<svg className="icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
			<path d={ICONS[props.name]} fill="currentColor" fillRule="evenodd" />
		</svg>
	);
}
