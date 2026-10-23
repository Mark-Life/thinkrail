type ListDir = (dir: string) => Promise<readonly { path: string }[]>;

function parentOf(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? "." : path.slice(0, slash);
}

/**
 * False only when the name is gone from a folder that could be listed, or the folder itself is gone.
 * Any other failure rejects, so the caller leaves the buffer alone.
 */
export async function fileExists(listDir: ListDir, path: string): Promise<boolean> {
	const dir = parentOf(path);
	try {
		const nodes = await listDir(dir);
		return nodes.some((node) => node.path === path);
	} catch (error) {
		if (dir !== "." && !(await fileExists(listDir, dir))) return false;
		throw error;
	}
}
