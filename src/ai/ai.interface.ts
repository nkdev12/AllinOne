export type TaskPriority = "LOW" | "MEDIUM" | "HIGH";

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
