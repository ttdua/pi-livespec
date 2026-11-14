// Gitea response DTOs and their runtime guards. Required fields are enforced
// per endpoint, so a malformed answer is an `http` error, never a TypeError.

import { ForgeError } from "./errors.ts";

// Minimal DTOs: only the fields the mapping reads. Everything else stays `unknown`.
export interface UserDto {
	login?: string;
}
export interface LabelDto {
	id?: number;
	name?: string;
}
export interface IssueDto {
	number?: number;
	title?: string;
	body?: string;
	state?: string;
	user?: UserDto;
	updated_at?: string;
	content_version?: number;
	labels?: LabelDto[];
}
export interface PullDto extends IssueDto {
	merged?: boolean;
	merged_at?: string | null;
	head?: { ref?: string };
	base?: { ref?: string };
}
export interface CommentDto {
	id?: number;
	body?: string;
	user?: UserDto;
	created_at?: string;
	updated_at?: string;
}
export interface ReviewDto {
	id?: number;
	state?: string;
	body?: string;
	user?: UserDto;
}
export interface ReviewCommentDto {
	path?: string;
	line?: number;
	position?: number;
	body?: string;
	user?: UserDto;
}
export interface StatusDto {
	context?: string;
	status?: string;
	target_url?: string;
}
export type Json = Record<string, unknown>;

export function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Combined status: `state` is required; `statuses` may be absent or null (an empty set) but never another type. */
export function isCombinedStatusDto(value: unknown): value is Json {
	return isObject(value) && required(value.state, "string") && (value.statuses == null || Array.isArray(value.statuses));
}

export function isPermissionDto(value: unknown): value is Json {
	return isObject(value) && required(value.permission, "string");
}

export type Guard<T> = (value: unknown) => value is T;

// ---- DTO guards: required fields are enforced per endpoint; only fields Gitea
// really omits or nulls (issue/pull `body`, `user`, `target_url`, ...) stay optional ----

function optional(value: unknown, type: "string" | "number" | "boolean"): boolean {
	return value === undefined || value === null || typeof value === type;
}

function required(value: unknown, type: "string" | "number" | "boolean"): boolean {
	return typeof value === type;
}

function requiredText(value: unknown): boolean {
	return typeof value === "string" && value !== "";
}

function optionalObject(value: unknown, check: (o: Json) => boolean): boolean {
	return value === undefined || value === null || (isObject(value) && check(value));
}

/** A `user` object that must carry a login. */
function hasLogin(value: unknown): boolean {
	return isObject(value) && requiredText(value.login);
}

export function isUserDto(value: unknown): value is UserDto {
	return isObject(value) && requiredText(value.login);
}

export function isLabelDto(value: unknown): value is LabelDto {
	return isObject(value) && required(value.id, "number") && required(value.name, "string");
}

/** Fields shared by issues and pull requests. */
function hasCommonFields(value: Json): boolean {
	return (
		required(value.number, "number") &&
		required(value.title, "string") &&
		required(value.state, "string") &&
		required(value.updated_at, "string") &&
		optional(value.body, "string") &&
		optional(value.content_version, "number") &&
		optionalObject(value.user, (u) => optional(u.login, "string"))
	);
}

export function isIssueDto(value: unknown): value is IssueDto {
	return isObject(value) && hasCommonFields(value) && Array.isArray(value.labels) && value.labels.every(isLabelDto);
}

const hasRef = (value: unknown): boolean => isObject(value) && required(value.ref, "string");

export function isPullDto(value: unknown): value is PullDto {
	if (!isObject(value) || !hasCommonFields(value)) return false;
	const labelsOk = value.labels === undefined || value.labels === null || (Array.isArray(value.labels) && value.labels.every(isLabelDto));
	return labelsOk && optional(value.merged, "boolean") && optional(value.merged_at, "string") && hasRef(value.head) && hasRef(value.base);
}

export function isCommentDto(value: unknown): value is CommentDto {
	return (
		isObject(value) &&
		required(value.id, "number") &&
		required(value.body, "string") &&
		required(value.updated_at, "string") &&
		optional(value.created_at, "string") &&
		hasLogin(value.user)
	);
}

export function isReviewDto(value: unknown): value is ReviewDto {
	return isObject(value) && required(value.id, "number") && required(value.state, "string") && optional(value.body, "string") && hasLogin(value.user);
}

export function isReviewCommentDto(value: unknown): value is ReviewCommentDto {
	return (
		isObject(value) &&
		required(value.path, "string") &&
		required(value.body, "string") &&
		optional(value.line, "number") &&
		optional(value.position, "number") &&
		hasLogin(value.user)
	);
}

export function isFileDto(value: unknown): value is { filename?: string } {
	return isObject(value) && required(value.filename, "string");
}

export function isStatusDto(value: unknown): value is StatusDto {
	return isObject(value) && required(value.context, "string") && required(value.status, "string") && optional(value.target_url, "string");
}

export function shapeError(operation: string, status: number, expected: string): ForgeError {
	return new ForgeError({ code: "http", operation, status, message: `${operation}: HTTP ${status} response is not ${expected}` });
}
