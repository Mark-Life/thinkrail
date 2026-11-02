import { arr, bool, opt, type Static, str } from "@earendil-works/pi-schema";
import { NoParams, wireObj } from "./wire";

export const GithubAuthStatus = wireObj({
	connected: bool(),
	login: opt(str()),
	scopes: opt(arr(str())),
});
export type GithubAuthStatus = Static<typeof GithubAuthStatus>;

export const GITHUB_METHODS = {
	"github.authStatus": { params: NoParams, result: GithubAuthStatus },
	"github.refresh": { params: NoParams, result: GithubAuthStatus },
};
