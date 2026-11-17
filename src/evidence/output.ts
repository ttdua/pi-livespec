// Captured `Verify` output: streaming token redaction and the bounded tail
// shown in comments and tool results.

const REDACTED = Buffer.from("***");
const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION_TAG = 0x80;
const MAX_UTF8_CONTINUATIONS = 3;

/**
 * Redacts known tokens from a byte stream whose chunks may split a token. It holds back
 * `maxTokenLength - 1` bytes, so a token is only ever emitted as `***`, never in pieces.
 */
export class StreamRedactor {
	private readonly tokens: Buffer[];
	private readonly hold: number;
	private pending: Buffer = Buffer.alloc(0);

	constructor(tokens: string[]) {
		this.tokens = [...new Set(tokens.filter((t) => t !== ""))].map((t) => Buffer.from(t));
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

	/** Replaces every token that starts before `buf.length - hold`; returns what is safe to emit and keeps the rest. */
	private drain(buf: Buffer, hold: number): Buffer {
		const limit = buf.length - hold;
		const out: Buffer[] = [];
		let cursor = 0;
		for (let match = this.firstMatch(buf, cursor); match && match.at < limit; match = this.firstMatch(buf, cursor)) {
			out.push(buf.subarray(cursor, match.at), REDACTED);
			cursor = match.at + match.length;
		}
		const emitTo = Math.max(cursor, limit);
		out.push(buf.subarray(cursor, emitTo));
		this.pending = Buffer.from(buf.subarray(emitTo));
		return Buffer.concat(out);
	}

	/** The earliest token occurrence at or after `from`; the longest token wins a tie. */
	private firstMatch(buf: Buffer, from: number): { at: number; length: number } | undefined {
		let best: { at: number; length: number } | undefined;
		for (const token of this.tokens) {
			const at = buf.indexOf(token, from);
			if (at < 0) continue;
			if (!best || at < best.at || (at === best.at && token.length > best.length)) best = { at, length: token.length };
		}
		return best;
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
	const budget = Math.max(0, maxBytes - Buffer.byteLength(markFor(totalBytes)));
	const start = firstStartWithin(tail, budget);
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
