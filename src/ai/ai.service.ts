import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { ConfigService } from "@nestjs/config";
import {
  ChangeOperation,
  TaskPriority as PrismaTaskPriority,
} from "@prisma/client";
import {
  ExtractedTask,
  ExtractedTasksResult,
  SuggestedTagsResult,
  SummaryResult,
  TaskPriority,
} from "./ai.interface";
import {
  ConvertTasksDto,
  ExtractTasksDto,
  SuggestTagsDto,
  SummarizeTextDto,
} from "./dto/ai.dto";

const STOP_WORDS = new Set([
  "a",
  "about",
  "above",
  "after",
  "again",
  "against",
  "all",
  "am",
  "an",
  "and",
  "any",
  "are",
  "aren't",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "below",
  "between",
  "both",
  "but",
  "by",
  "can't",
  "cannot",
  "could",
  "couldn't",
  "did",
  "didn't",
  "do",
  "does",
  "doesn't",
  "doing",
  "don't",
  "down",
  "during",
  "each",
  "few",
  "for",
  "from",
  "further",
  "had",
  "hadn't",
  "has",
  "hasn't",
  "have",
  "haven't",
  "having",
  "he",
  "he'd",
  "he'll",
  "he's",
  "her",
  "here",
  "here's",
  "hers",
  "herself",
  "him",
  "himself",
  "his",
  "how",
  "how's",
  "i",
  "i'd",
  "i'll",
  "i'm",
  "i've",
  "if",
  "in",
  "into",
  "is",
  "isn't",
  "it",
  "it's",
  "its",
  "itself",
  "let's",
  "me",
  "more",
  "most",
  "mustn't",
  "my",
  "myself",
  "no",
  "nor",
  "not",
  "of",
  "off",
  "on",
  "once",
  "only",
  "or",
  "other",
  "ought",
  "our",
  "ours",
  "ourselves",
  "out",
  "over",
  "own",
  "same",
  "shan't",
  "she",
  "she'd",
  "she'll",
  "she's",
  "should",
  "shouldn't",
  "so",
  "some",
  "such",
  "than",
  "that",
  "that's",
  "the",
  "their",
  "theirs",
  "them",
  "themselves",
  "then",
  "there",
  "there's",
  "these",
  "they",
  "they'd",
  "they'll",
  "they're",
  "they've",
  "this",
  "those",
  "through",
  "to",
  "too",
  "under",
  "until",
  "up",
  "very",
  "was",
  "wasn't",
  "we",
  "we'd",
  "we'll",
  "we're",
  "we've",
  "were",
  "weren't",
  "what",
  "what's",
  "when",
  "when's",
  "where",
  "where's",
  "which",
  "while",
  "who",
  "who's",
  "whom",
  "why",
  "why's",
  "with",
  "won't",
  "would",
  "wouldn't",
  "you",
  "you'd",
  "you'll",
  "you're",
  "you've",
  "your",
  "yours",
  "yourself",
  "yourselves",
]);

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  private mapToPrismaPriority(priority?: TaskPriority): PrismaTaskPriority {
    switch (priority) {
      case "HIGH":
        return PrismaTaskPriority.P1_URGENT;
      case "LOW":
        return PrismaTaskPriority.P4_LOW;
      case "MEDIUM":
      default:
        return PrismaTaskPriority.P3_MEDIUM;
    }
  }

  private async resolveText(
    userId: string,
    text?: string,
    noteId?: string,
  ): Promise<{ content: string; title?: string }> {
    if (text && text.trim().length > 0) {
      return { content: text.trim() };
    }

    if (noteId) {
      const note = await this.prisma.note.findFirst({
        where: { id: noteId, userId, deletedAt: null },
      });
      if (!note) {
        throw new NotFoundException(`Note with ID '${noteId}' not found.`);
      }
      return {
        content: `${note.title}\n\n${note.content || ""}`.trim(),
        title: note.title,
      };
    }

    throw new BadRequestException(
      "Either 'text' or 'noteId' must be provided.",
    );
  }

  async summarize(
    userId: string,
    dto: SummarizeTextDto,
  ): Promise<SummaryResult> {
    const { content } = await this.resolveText(userId, dto.text, dto.noteId);
    const geminiKey = this.configService.get<string>("GEMINI_API_KEY");

    if (geminiKey && geminiKey.trim().length > 0) {
      try {
        const geminiResult = await this.summarizeWithGemini(
          content,
          geminiKey,
          dto.length || "brief",
          dto.format || "paragraph",
        );
        if (geminiResult) {
          return geminiResult;
        }
      } catch (err: any) {
        this.logger.warn(
          `Gemini API call failed, using heuristic fallback: ${err.message}`,
        );
      }
    }

    return this.summarizeHeuristic(
      content,
      dto.length || "brief",
      dto.format || "paragraph",
    );
  }

  private async summarizeWithGemini(
    content: string,
    apiKey: string,
    length: string,
    format: string,
  ): Promise<SummaryResult | null> {
    const prompt = `Summarize the following text in a ${length} manner, formatted as ${format}. Text:\n\n${content}`;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Gemini status code ${response.status}`);
    }

    const data = (await response.json()) as any;
    const generated = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!generated) {
      return null;
    }

    return {
      summary: generated,
      originalLength: content.length,
      summaryLength: generated.length,
      compressionRatio: +(generated.length / (content.length || 1)).toFixed(2),
      format: format as any,
      provider: "gemini",
    };
  }

  private summarizeHeuristic(
    content: string,
    length: string,
    format: string,
  ): SummaryResult {
    // 1. Split into sentences
    const sentences = content
      .split(/(?<=[.?!])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 15);

    if (sentences.length <= 1) {
      return {
        summary: content,
        originalLength: content.length,
        summaryLength: content.length,
        compressionRatio: 1.0,
        format: format as any,
        provider: "heuristic",
      };
    }

    // 2. Compute word frequencies
    const words = content.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
    const freq: Record<string, number> = {};
    for (const word of words) {
      if (!STOP_WORDS.has(word)) {
        freq[word] = (freq[word] || 0) + 1;
      }
    }

    // 3. Score sentences
    const scored = sentences.map((sentence, idx) => {
      const sentenceWords =
        sentence.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
      let score = 0;
      for (const w of sentenceWords) {
        score += freq[w] || 0;
      }
      // Position boost (first sentence and introductory clauses are important)
      const positionWeight = idx === 0 ? 1.5 : idx < 3 ? 1.2 : 1.0;
      return { sentence, score: score * positionWeight, index: idx };
    });

    // 4. Select top sentences based on requested length
    let targetCount = length === "brief" ? 2 : length === "detailed" ? 5 : 3;
    targetCount = Math.min(targetCount, sentences.length);

    const topSentences = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, targetCount)
      .sort((a, b) => a.index - b.index)
      .map((s) => s.sentence);

    const summary =
      format === "bullet_points"
        ? topSentences.map((s) => `• ${s}`).join("\n")
        : topSentences.join(" ");

    return {
      summary,
      originalLength: content.length,
      summaryLength: summary.length,
      compressionRatio: +(summary.length / (content.length || 1)).toFixed(2),
      format: format as any,
      provider: "heuristic",
    };
  }

  async extractTasks(
    userId: string,
    dto: ExtractTasksDto,
  ): Promise<ExtractedTasksResult> {
    const { content } = await this.resolveText(userId, dto.text, dto.noteId);
    const lines = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const tasks: ExtractedTask[] = [];

    const actionKeywords = [
      "todo",
      "action item",
      "must",
      "need to",
      "implement",
      "deploy",
      "review",
      "verify",
      "prepare",
      "update",
      "check",
      "fix",
      "schedule",
      "follow up",
      "audit",
    ];

    for (const line of lines) {
      let isTask = false;
      let cleanLine = line;

      // Markdown checkbox: - [ ] Task
      if (/^[-*]\s*\[\s*\]\s+/i.test(line)) {
        isTask = true;
        cleanLine = line.replace(/^[-*]\s*\[\s*\]\s+/i, "");
      } else if (/^(todo|action item)[:\s-]+/i.test(line)) {
        isTask = true;
        cleanLine = line.replace(/^(todo|action item)[:\s-]+/i, "");
      } else if (!line.endsWith(":")) {
        const lower = line.toLowerCase();
        for (const kw of actionKeywords) {
          if (lower.startsWith(kw)) {
            isTask = true;
            break;
          }
        }
      }

      if (isTask && cleanLine.length > 5) {
        let priority: TaskPriority = "MEDIUM";
        const lower = cleanLine.toLowerCase();
        if (
          lower.includes("urgent") ||
          lower.includes("critical") ||
          lower.includes("asap") ||
          lower.includes("p0") ||
          lower.includes("high")
        ) {
          priority = "HIGH";
        } else if (
          lower.includes("low") ||
          lower.includes("optional") ||
          lower.includes("later") ||
          lower.includes("consider")
        ) {
          priority = "LOW";
        }

        tasks.push({
          title: cleanLine.charAt(0).toUpperCase() + cleanLine.slice(1),
          priority,
        });
      }
    }

    return {
      tasks,
      totalFound: tasks.length,
      provider: "heuristic",
    };
  }

  async suggestTags(
    userId: string,
    dto: SuggestTagsDto,
  ): Promise<SuggestedTagsResult> {
    const { content } = await this.resolveText(userId, dto.text, dto.noteId);

    const words = content.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
    const freq: Record<string, number> = {};

    for (const word of words) {
      if (!STOP_WORDS.has(word)) {
        freq[word] = (freq[word] || 0) + 1;
      }
    }

    const sortedTags = Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);

    // Contextual categories
    const categories: string[] = [];
    const lower = content.toLowerCase();
    if (
      lower.includes("auth") ||
      lower.includes("security") ||
      lower.includes("jwt")
    ) {
      categories.push("Security");
    }
    if (
      lower.includes("database") ||
      lower.includes("prisma") ||
      lower.includes("redis")
    ) {
      categories.push("Infrastructure");
    }
    if (
      lower.includes("meeting") ||
      lower.includes("roadmap") ||
      lower.includes("team")
    ) {
      categories.push("Productivity");
    }
    if (categories.length === 0) {
      categories.push("General");
    }

    return {
      tags: sortedTags,
      suggestedCategories: categories,
      provider: "heuristic",
    };
  }

  async convertTasksForNote(
    userId: string,
    noteId: string,
    dto: ConvertTasksDto,
  ): Promise<{ createdCount: number; tasks: any[] }> {
    const note = await this.prisma.note.findFirst({
      where: { id: noteId, userId, deletedAt: null },
    });

    if (!note) {
      throw new NotFoundException(`Note with ID '${noteId}' not found.`);
    }

    const createdTasks = await this.prisma.$transaction(async (tx) => {
      const results = [];
      for (const item of dto.tasks) {
        const task = await tx.task.create({
          data: {
            userId,
            title: item.title,
            description:
              item.description || `Extracted from note: "${note.title}"`,
            priority: this.mapToPrismaPriority(item.priority),
            dueDate: item.dueDate ? new Date(item.dueDate) : undefined,
          },
        });

        await tx.change.create({
          data: {
            userId,
            entityType: "task",
            entityId: task.id,
            operation: ChangeOperation.CREATE,
            version: 1,
            payload: {
              title: task.title,
              priority: task.priority,
              extractedFromNoteId: noteId,
            },
          },
        });

        results.push(task);
      }
      return results;
    });

    return {
      createdCount: createdTasks.length,
      tasks: createdTasks,
    };
  }
}

