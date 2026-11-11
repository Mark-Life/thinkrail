#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { renderThemeSchema, THEME_SCHEMA_PATH } from "./themeSchema";

writeFileSync(THEME_SCHEMA_PATH, renderThemeSchema());
