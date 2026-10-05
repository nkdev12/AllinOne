import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/**
 * Every outbound call the AI module makes to Google's Generative Language
 * API lives here: the endpoint shape, where the secret goes, how long we are
 * willing to wait, and how much text we are willing to put on the wire.
 *
 * Two rules are enforced here because breaking them was a real defect:
 *
 * 1. `GEMINI_API_KEY` travels in the `x-goog-api-key` header and never in
 *    the URL. URLs get copied into proxy access logs, into `Error` text and
 *    into anything else that prints a request line, so a query-string secret
 *    leaks in places no one intended.
 * 2. Every request carries an abort deadline. These calls run inside an
 *    authenticated HTTP request worker, so an unbounded `fetch` means one
 *    stalled upstream pins a worker until the socket gives up.
 *
 * Nothing in this file logs the key, the prompt or the response body, and the
 * error text it throws is built from the status code alone — safe to log,
 * because it can never carry the key or the request headers.
 */

const GENERATE_CONTENT_ROOT =
  "https://generativelanguage.googleapis.com/v1beta/models";

/** Model used when `GEMINI_MODEL` is unset: the value this module shipped with. */
export const DEFAULT_GEMINI_MODEL = "gemini-1.5-flash";

/** Deadline used when `GEMINI_TIMEOUT_MS` is unset or not a positive number. */
export const DEFAULT_GEMINI_TIMEOUT_MS = 5000;

/**
 * Hard ceiling on the prompt we send upstream, counted in characters (for
 * non-ASCII text the UTF-8 byte count is higher, but still bounded, and
 * note text is mostly ASCII). 8,000 characters is roughly 10-11k tokens,
 * well past the point where summarizing note text improves.
 *
 * `resolveText()` hands over an entire note body and the DTO only requires
 * `text` to be a string, so an over-long body is truncated with
 * {@link GEMINI_TRUNCATION_MARKER} rather than failing the request: the
 * caller still gets a summary of the head of the note. The heuristic
 * summarizer always sees the full, untruncated text.
 */
export const MAX_GEMINI_PROMPT_CHARS = 8000;

/** Appended when a prompt was cut, so a terse answer can be blamed on the cap. */
export const GEMINI_TRUNCATION_MARKER = "\n\n[content truncated]";

/**
 * Cut `prompt` down to `limit` characters, marker included, so the result is
 * never longer than `limit`. Text within the budget is returned unchanged.
 */
export function truncateGeminiPrompt(
  prompt: string,
  limit = MAX_GEMINI_PROMPT_CHARS,
): string {
  if (prompt.length <= limit) {
    return prompt;
  }
  const keep = Math.max(0, limit - GEMINI_TRUNCATION_MARKER.length);
  return `${prompt.slice(0, keep)}${GEMINI_TRUNCATION_MARKER}`;
}

@Injectable()
export class GeminiClient {
  constructor(private readonly config: ConfigService) {}

  /** Trimmed `GEMINI_API_KEY`, or `undefined` when none is configured. */
  get apiKey(): string | undefined {
    const raw = this.config.get<string>("GEMINI_API_KEY");
    return typeof raw === "string" && raw.trim().length > 0
      ? raw.trim()
      : undefined;
  }

  /**
   * False for a missing, empty or whitespace-only key — the whole remote
   * path is then skipped and no request is attempted.
   */
  get isConfigured(): boolean {
    return this.apiKey !== undefined;
  }

  /** `GEMINI_MODEL`, falling back to {@link DEFAULT_GEMINI_MODEL}. */
  get model(): string {
    const raw = this.config.get<string>("GEMINI_MODEL");
    return typeof raw === "string" && raw.trim().length > 0
      ? raw.trim()
      : DEFAULT_GEMINI_MODEL;
  }

  /** `GEMINI_TIMEOUT_MS` as a positive integer ms, else the default. */
  get timeoutMs(): number {
    const raw = Number(this.config.get<string | number>("GEMINI_TIMEOUT_MS"));
    return Number.isFinite(raw) && raw > 0
      ? Math.trunc(raw)
      : DEFAULT_GEMINI_TIMEOUT_MS;
  }

  /**
   * Posts one prompt and resolves to the generated text, or `null` when
   * Google answered 2xx with nothing usable (or no key is configured).
   *
   * Throws on a transport failure, when the abort deadline fires, and on any
   * non-2xx status. Deciding what to do about that belongs to the caller:
   * `AiService` deliberately degrades to its deterministic heuristics, so no
   * AI endpoint can fail because Gemini is down or slow.
   */
  async generateText(prompt: string): Promise<string | null> {
    const apiKey = this.apiKey;
    if (!apiKey) {
      return null;
    }

    const url = `${GENERATE_CONTENT_ROOT}/${this.model}:generateContent`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: truncateGeminiPrompt(prompt) }] }],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Gemini status code ${response.status}`);
    }

    const data = (await response.json()) as any;
    const generated = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    return generated ? generated : null;
  }
}
