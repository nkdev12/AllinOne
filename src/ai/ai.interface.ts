export type SummaryLength = "brief" | "detailed" | "bullet_points";
export type SummaryFormat = "paragraph" | "bullet_points";
export type TaskPriority = "LOW" | "MEDIUM" | "HIGH";

/** Who answered an `/ai` request. See the per-result notes below. */
export type AiProvider = "gemini" | "heuristic";

export interface SummaryResult {
  summary: string;
  originalLength: number;
  summaryLength: number;
  compressionRatio: number;
  format: SummaryFormat;
  /**
   * The provider that actually answered. `"gemini"` requires a non-blank
   * `GEMINI_API_KEY` and a call that returned usable text inside
   * `GEMINI_TIMEOUT_MS`; a missing key, a non-2xx, a transport error, a
   * timeout or an empty candidate all answer `"heuristic"`.
   */
  provider: AiProvider;
}

export interface ExtractedTask {
  title: string;
  description?: string;
  priority: TaskPriority;
  dueDateSuggestion?: string;
  suggestedTags?: string[];
}

export interface ExtractedTasksResult {
  tasks: ExtractedTask[];
  totalFound: number;
  /**
   * Always `"heuristic"`: `extractTasks()` has no provider code path, so no
   * AI configuration — including `GEMINI_API_KEY` — changes this value.
   * Typed as a literal so a future provider branch has to widen it on purpose.
   */
  provider: "heuristic";
}

export interface SuggestedTagsResult {
  tags: string[];
  suggestedCategories: string[];
  /** Always `"heuristic"` — see `ExtractedTasksResult["provider"]`. */
  provider: "heuristic";
}
