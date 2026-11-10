import { createCn } from "cn/config";

const isLayoutRole = (value: string) => /^[a-z]+(?:-[a-z]+)+$/.test(value);

export const cn = createCn({ extend: { theme: { spacing: [isLayoutRole] } } });
