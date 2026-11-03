import type { ContractChange, SymbolId } from "../../../core/types";
import { bucketContracts, type SignaturePart, signatureDelta } from "../../lib/changes";
import { displayName, kindLabel, shortModule } from "../../lib/format";
import { mapHref, symbolHref } from "../../lib/route";
import { useGraph, useWorkspace } from "../../lib/workspace";

function SymbolLabel(props: { id: SymbolId; side: "head" | "base" }) {
	const index = useGraph(props.side);
	const symbol = index.symbols.get(props.id);
	if (!symbol) return <code>{props.id}</code>;
	return (
		<a className="contract-symbol" href={symbolHref(props.id, props.side)} title={symbol.file}>
			<span className="kind-badge">{kindLabel(symbol.kind)}</span>
			<span className="symbol-row-name">{displayName(symbol)}</span>
			<span className="symbol-row-module">{shortModule(symbol.module)}</span>
		</a>
	);
}

function ExportRow(props: { contract: Extract<ContractChange, { symbol: SymbolId }> }) {
	const { contract } = props;
	const added = contract.kind === "export-added";
	return (
		<li className="contract-row">
			<span className={`status-mark ${added ? "status-added" : "status-removed"}`}>
				{added ? "+" : "-"}
			</span>
			<SymbolLabel id={contract.symbol} side={added ? "head" : "base"} />
		</li>
	);
}

function SignatureLine(props: {
	mark: string;
	tone: string;
	title: string;
	parts: readonly SignaturePart[];
}) {
	return (
		<pre className={props.tone} title={props.title}>
			<span className="diff-mark">{props.mark}</span>
			{props.parts.map((part, position) => (
				<span
					key={`${position}:${part.text.length}`}
					className={part.changed ? "signature-delta" : undefined}
				>
					{part.text}
				</span>
			))}
		</pre>
	);
}

function SignatureLines(props: { before: string; after: string }) {
	const delta = signatureDelta(props);
	if (delta.same) {
		return (
			<p className="list-empty">The change is past the part of the signature that is printed.</p>
		);
	}
	return (
		<>
			<SignatureLine mark="-" tone="signature-before" title={props.before} parts={delta.before} />
			<SignatureLine mark="+" tone="signature-after" title={props.after} parts={delta.after} />
		</>
	);
}

function Section(props: { title: string; count: number; children: React.ReactNode }) {
	return (
		<section className="contract-section">
			<h3 className="section-title">
				{props.title} <span className="section-count">{props.count}</span>
			</h3>
			{props.count === 0 ? <p className="list-empty">No changes.</p> : props.children}
		</section>
	);
}

export function ContractsSection() {
	const { diff } = useWorkspace();
	if (!diff) return null;
	const buckets = bucketContracts(diff.diff.contracts);
	return (
		<div className="contracts">
			<h2 className="group-title">Contracts</h2>
			<p className="blast-summary">
				What other code can see: public exports, signatures, wire methods and module dependencies.
			</p>
			<Section title="Wire methods" count={buckets.wire.length}>
				<ul className="contract-list">
					{buckets.wire.map((contract) =>
						contract.kind === "wire-method-added" || contract.kind === "wire-method-removed" ? (
							<li key={`${contract.kind}:${contract.method}`} className="contract-row">
								<span
									className={`status-mark ${contract.kind === "wire-method-added" ? "status-added" : "status-removed"}`}
								>
									{contract.kind === "wire-method-added" ? "+" : "-"}
								</span>
								<code>{contract.method}</code>
							</li>
						) : null,
					)}
				</ul>
			</Section>
			<Section title="Signatures" count={buckets.signatures.length}>
				<ul className="contract-list">
					{buckets.signatures.map((contract) =>
						contract.kind === "signature-changed" ? (
							<li key={contract.symbol} className="contract-signature">
								<div className="contract-row">
									<span className="status-mark status-modified">~</span>
									<SymbolLabel id={contract.symbol} side="head" />
								</div>
								<SignatureLines before={contract.before} after={contract.after} />
							</li>
						) : null,
					)}
				</ul>
			</Section>
			<Section title="Public exports" count={buckets.exports.length}>
				<ul className="contract-list">
					{buckets.exports.map((contract) =>
						contract.kind === "export-added" || contract.kind === "export-removed" ? (
							<ExportRow key={`${contract.kind}:${contract.symbol}`} contract={contract} />
						) : null,
					)}
				</ul>
			</Section>
			<Section title="Module dependencies" count={buckets.modules.length}>
				<ul className="contract-list">
					{buckets.modules.map((contract) =>
						contract.kind === "module-dependency-added" ||
						contract.kind === "module-dependency-removed" ? (
							<li key={`${contract.kind}:${contract.from}:${contract.to}`} className="contract-row">
								<span
									className={`status-mark ${contract.kind === "module-dependency-added" ? "status-added" : "status-removed"}`}
								>
									{contract.kind === "module-dependency-added" ? "+" : "-"}
								</span>
								<a className="module-link-name" href={mapHref({ path: contract.from })}>
									{shortModule(contract.from)}
								</a>
								<span className="contract-arrow">depends on</span>
								<a className="module-link-name" href={mapHref({ path: contract.to })}>
									{shortModule(contract.to)}
								</a>
							</li>
						) : null,
					)}
				</ul>
			</Section>
		</div>
	);
}
