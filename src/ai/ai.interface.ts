export type SummaryLength = "brief" | "detailed" | "bullet_points";
export type SummaryFormat = "paragraph" | "bullet_points";
export type TaskPriority = "LOW" | "MEDIUM" | "HIGH";

export interface SummaryResult {
  summary: string;
  originalLength: number;
  summaryLength: number;
  compressionRatio: number;
  format: SummaryFormat;
  provider: "gemini" | "heuristic";
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
  provider: "gemini" | "heuristic";
}

export interface SuggestedTagsResult {
  tags: string[];
  suggestedCategories: string[];
  provider: "gemini" | "heuristic";
}
