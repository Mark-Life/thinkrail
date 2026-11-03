import { lit, nullable, num, oneOf, opt, type Static, str, union } from "@earendil-works/pi-schema";
import { GitDiffScope } from "./diffScope";
import { WorkspaceId } from "./ids";
import { wireObj } from "./wire";

export const LineSpan = wireObj({ start: num(), count: num() });
export type LineSpan = Static<typeof LineSpan>;

export const RevertTarget = union([
	wireObj({ kind: lit("file") }),
	wireObj({ kind: lit("range"), original: LineSpan, modified: LineSpan }),
]);
export type RevertTarget = Static<typeof RevertTarget>;

const ChangeReceiptSide = wireObj({
	hash: nullable(str()),
	byteLength: nullable(num()),
	mode: nullable(num()),
});

export const ChangeReceipt = wireObj({
	id: str(),
	workspaceId: WorkspaceId,
	path: str(),
	kind: oneOf(["revert", "undo"]),
	at: num(),
	before: ChangeReceiptSide,
	after: ChangeReceiptSide,
	trashed: opt(str()),
});
export type ChangeReceipt = Static<typeof ChangeReceipt>;

export const CHANGE_METHODS = {
	"change.revert": {
		params: wireObj({
			workspaceId: WorkspaceId,
			path: str(),
			scope: GitDiffScope,
			target: RevertTarget,
			expect: wireObj({ originalHash: nullable(str()), modifiedHash: nullable(str()) }),
		}),
		result: wireObj({ receipt: ChangeReceipt }),
	},
	"change.undo": {
		params: wireObj({
			workspaceId: WorkspaceId,
			receiptId: str(),
			expect: wireObj({ modifiedHash: nullable(str()) }),
		}),
		result: wireObj({ receipt: ChangeReceipt }),
	},
};
