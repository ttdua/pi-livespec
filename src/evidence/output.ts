// Captured `Verify` output: streaming token redaction and the bounded tail
// shown in comments and tool results.

import { redactTokens } from "../accounts/redact.ts";

const BYTE_ENCODING = "latin1";
const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION_TAG = 0x80;
const MAX_UTF8_CONTINUATIONS = 3;

/**
 * Redacts known tokens from a byte stream whose chunks may split a token. It holds back
 * `maxTokenLength - 1` bytes, so a token is only ever emitted as `***`, never in pieces.
 */
export class StreamRedactor {
	private readonly tokens: Buffer[];
	private readonly tokenStrings: string[];
	private readonly hold: number;
	private pending: Buffer = Buffer.alloc(0);

	constructor(tokens: string[]) {
		const known = [...new Set(tokens.filter((t) => t !== ""))];
		this.tokens = known.map((t) => Buffer.from(t));
		this.tokenStrings = this.tokens.map((t) => t.toString(BYTE_ENCODING));
		this.hold = Math.max(0, ...this.tokens.map((t) => t.length - 1));
	}

	/** Redacted bytes that are safe to emit; the last bytes that may start a token are kept for the next call. */
	push(chunk: Buffer): Buffer {
		return this.drain(Buffer.concat([this.pending, chunk]), this.hold);
	}

	/** The remaining held bytes, redacted. */
	end(): Buffer {
		return this.drain(this.pending, 0);
	}

	/** Emits the redacted bytes before the boundary and keeps the rest; replacement is `redactTokens`. */
	private drain(buf: Buffer, hold: number): Buffer {
		const emitTo = this.boundary(buf, buf.length - hold);
		this.pending = Buffer.from(buf.subarray(emitTo));
		// Latin-1 maps each byte to one char, so byte-exact matching and redaction survive binary data.
		const text = buf.subarray(0, emitTo).toString(BYTE_ENCODING);
		return Buffer.from(redactTokens(text, this.tokenStrings), BYTE_ENCODING);
	}

	/** `limit`, moved past the end of any token that starts before it, so no token is cut in two. */
	private boundary(buf: Buffer, limit: number): number {
		let emitTo = Math.max(0, limit);
		for (let moved = true; moved; ) {
			moved = false;
			for (const token of this.tokens) {
				const at = buf.indexOf(token, Math.max(0, emitTo - token.length + 1));
				if (at >= 0 && at < emitTo && at + token.length > emitTo) {
					emitTo = at + token.length;
					moved = true;
				}
			}
		}
		return emitTo;
	}
}

const decoder = new TextDecoder("utf-8", { fatal: false });

const isContinuation = (byte: number | undefined): boolean =>
	byte !== undefined && (byte & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION_TAG;

/** Moves `start` past at most three UTF-8 continuation bytes, so decoding does not begin inside a character. */
function alignStart(buf: Buffer, start: number): number {
	let at = start;
	while (at < buf.length && at - start < MAX_UTF8_CONTINUATIONS && isContinuation(buf[at])) at++;
	return at;
}

/** Decodes `buf` from `start` (aligned), replacing invalid bytes with U+FFFD. */
const decodeFrom = (buf: Buffer, start: number): string => decoder.decode(buf.subarray(alignStart(buf, start)));

const ELLIPSIS = "…";
const markFor = (dropped: number): string => `…[truncated ${dropped} bytes]\n`;

/**
 * The text of the last bytes of an output of `totalBytes` bytes, of which `tail` holds the end.
 * Invalid bytes become U+FFFD and the cut falls on a UTF-8 boundary. When bytes are dropped,
 * the text starts with `…[truncated N bytes]\n`; the whole result is at most `maxBytes` bytes.
 */
export function outputTail(tail: Buffer, totalBytes: number, maxBytes: number): string {
	const whole = decoder.decode(tail);
	if (totalBytes <= tail.length && Buffer.byteLength(whole) <= maxBytes) return whole;
	// `N` never exceeds `totalBytes`, so a mark sized for it leaves room for the real one.
	const room = maxBytes - Buffer.byteLength(markFor(totalBytes));
	// A budget below the mark holds no tail: a bare ellipsis if it fits, otherwise nothing.
	if (room < 0) return Buffer.byteLength(ELLIPSIS) <= maxBytes ? ELLIPSIS : "";
	const start = firstStartWithin(tail, room);
	const text = start < tail.length ? decodeFrom(tail, start) : "";
	const shown = tail.length - alignStart(tail, start);
	return markFor(Math.max(0, totalBytes - shown)) + text;
}

/** The smallest start offset whose decoded rest fits in `budget` bytes (decoded size shrinks as the start grows). */
function firstStartWithin(tail: Buffer, budget: number): number {
	let low = Math.max(0, tail.length - budget);
	let high = tail.length;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (Buffer.byteLength(decodeFrom(tail, mid)) <= budget) high = mid;
		else low = mid + 1;
	}
	return low;
}
