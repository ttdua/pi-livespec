// Text helpers shared by the init, doctor and skills commands.

import type { PackError } from "../engine/pack-types.ts";

export const formatPackError = (e: PackError): string => `${e.file}:${e.line}:${e.col} ${e.path}: ${e.message}`;

export { messageOf } from "../core/messages.ts";
