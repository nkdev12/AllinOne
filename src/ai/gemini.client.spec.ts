import { ConfigService } from "@nestjs/config";
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_TIMEOUT_MS,
  GeminiClient,
  GEMINI_TRUNCATION_MARKER,
  MAX_GEMINI_PROMPT_CHARS,
  truncateGeminiPrompt,
} from "./gemini.client";

const KEY = "AIzaCLIENT-key-must-stay-in-a-header";

/** The one `{ url, init }` pair the client handed to fetch. */
function singleCall(fetchMock: jest.Mock) {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  return { url: url as string, init: init as any };
}

function build(env: Record<string, unknown>): {
  client: GeminiClient;
  fetchMock: jest.Mock;
} {
  const config = {
    get: jest.fn((key: string, fallback?: unknown) =>
      key in env ? env[key] : fallback,
    ),
  };
  const fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  return {
    client: new GeminiClient(config as unknown as ConfigService),
    fetchMock,
  };
}

describe("GeminiClient", () => {
  afterEach(() => {
    delete (global as any).fetch;
  });

  describe("where the secret goes", () => {
    it("posts to a secret-free URL and puts the key in x-goog-api-key", async () => {
      const { client, fetchMock } = build({ GEMINI_API_KEY: KEY });
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "Summary." }] } }],
        }),
      });

      await expect(client.generateText("summarize this")).resolves.toBe(
        "Summary.",
      );

      const { url, init } = singleCall(fetchMock);
      expect(url).not.toContain("key=");
      expect(url).not.toContain(KEY);
      expect(url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent",
      );
      expect(init.method).toBe("POST");
      expect(init.headers["x-goog-api-key"]).toBe(KEY);
      expect(init.headers["Content-Type"]).toBe("application/json");
    });

    it("keeps the key out of the error text it throws for a non-2xx", async () => {
      const { client, fetchMock } = build({ GEMINI_API_KEY: KEY });
      fetchMock.mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({ error: { message: "quota exhausted" } }),
      });

      await expect(client.generateText("summarize this")).rejects.toThrow(
        "Gemini status code 429",
      );
      const { url } = singleCall(fetchMock);
      expect(url).not.toContain(KEY);
    });

    it("does not call fetch at all without a usable key", async () => {
      for (const raw of [undefined, "", "   "]) {
        const { client, fetchMock } = build({ GEMINI_API_KEY: raw });
        expect(client.isConfigured).toBe(false);
        await expect(client.generateText("summarize this")).resolves.toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
      }
    });
  });

  describe("configuration", () => {
    it("reads the model from GEMINI_MODEL and falls back to the shipped name", () => {
      expect(
        build({ GEMINI_API_KEY: KEY, GEMINI_MODEL: "gemini-2.5-pro" }).client
          .model,
      ).toBe("gemini-2.5-pro");

      for (const raw of [undefined, "", "  "]) {
        expect(
          build({ GEMINI_API_KEY: KEY, GEMINI_MODEL: raw }).client.model,
        ).toBe(DEFAULT_GEMINI_MODEL);
      }
    });

    it("reads the deadline from GEMINI_TIMEOUT_MS and falls back to the default", () => {
      // Environment values arrive as strings, so this has to coerce.
      expect(
        build({ GEMINI_API_KEY: KEY, GEMINI_TIMEOUT_MS: "2500" }).client
          .timeoutMs,
      ).toBe(2500);

      for (const raw of [undefined, "", "0", "-5", "soon", {}]) {
        expect(
          build({ GEMINI_API_KEY: KEY, GEMINI_TIMEOUT_MS: raw }).client
            .timeoutMs,
        ).toBe(DEFAULT_GEMINI_TIMEOUT_MS);
      }
    });

    it("passes the deadline to fetch as an abort signal", async () => {
      const { client, fetchMock } = build({
        GEMINI_API_KEY: KEY,
        GEMINI_TIMEOUT_MS: "4000",
      });
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "x" }] } }],
        }),
      });

      await client.generateText("summarize this");

      const { init } = singleCall(fetchMock);
      expect(init.signal).toBeDefined();
      expect(typeof init.signal.aborted).toBe("boolean");
    });
  });

  describe("size cap", () => {
    it("leaves a prompt within the limit untouched and cuts the tail otherwise", () => {
      const short = "Summarize the following text.";
      expect(truncateGeminiPrompt(short)).toBe(short);

      const cut = truncateGeminiPrompt("x".repeat(MAX_GEMINI_PROMPT_CHARS * 2));
      expect(cut.length).toBe(MAX_GEMINI_PROMPT_CHARS);
      expect(cut.endsWith(GEMINI_TRUNCATION_MARKER)).toBe(true);

      expect(truncateGeminiPrompt("y".repeat(500), 100).length).toBe(100);
    });

    it("only ever puts a bounded prompt on the wire", async () => {
      const { client, fetchMock } = build({ GEMINI_API_KEY: KEY });
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "ok" }] } }],
        }),
      });

      await client.generateText(
        `head${"z".repeat(MAX_GEMINI_PROMPT_CHARS)}tail`,
      );

      const { init } = singleCall(fetchMock);
      const sent: string = JSON.parse(init.body).contents[0].parts[0].text;
      expect(sent.length).toBeLessThanOrEqual(MAX_GEMINI_PROMPT_CHARS);
      expect(sent.startsWith("head")).toBe(true);
      expect(sent).not.toContain("tail");
      expect(sent).toContain(GEMINI_TRUNCATION_MARKER);
    });
  });

  describe("failure modes", () => {
    it("aborts a stalled call when the deadline fires", async () => {
      const { client, fetchMock } = build({
        GEMINI_API_KEY: KEY,
        GEMINI_TIMEOUT_MS: "5",
      });
      fetchMock.mockImplementation(
        (init: any) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => {
              reject(init.signal.reason ?? new Error("aborted"));
            });
          }),
      );

      await expect(client.generateText("summarize this")).rejects.toThrow();
    });

    it("propagates a transport failure to the caller", async () => {
      const { client, fetchMock } = build({ GEMINI_API_KEY: KEY });
      fetchMock.mockRejectedValue(new TypeError("fetch failed"));

      await expect(client.generateText("summarize this")).rejects.toThrow(
        TypeError,
      );
    });

    it("resolves null when a 2xx answer carries no text", async () => {
      const { client, fetchMock } = build({ GEMINI_API_KEY: KEY });
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [] } }] }),
      });

      await expect(client.generateText("summarize this")).resolves.toBeNull();
    });
  });
});
