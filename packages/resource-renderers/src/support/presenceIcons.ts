import { RiChat2Line, RiLoginBoxLine, RiUserLine } from "@remixicon/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PresenceTone } from "../registry";

const kindIcon = (icon: typeof RiUserLine) => renderToStaticMarkup(createElement(icon));

const USER_ICON = kindIcon(RiUserLine);
const AGENT_ICON = kindIcon(RiChat2Line);
const EXTERNAL_ICON = kindIcon(RiLoginBoxLine);

export const presenceKindIcon = (tone: PresenceTone) =>
	tone === "user" ? USER_ICON : tone === "external" ? EXTERNAL_ICON : AGENT_ICON;
