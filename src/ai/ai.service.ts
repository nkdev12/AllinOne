import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { appendChange } from "@/sync/change-cursor";
import { SyncNotificationService } from "@/sync/sync-notification.service";
import {
  ChangeOperation,
  TaskPriority as PrismaTaskPriority,
} from "@prisma/client";
import {
  ExtractedTask,
  ExtractedTasksResult,
  SuggestedTagsResult,
  TaskPriority,
} from "./ai.interface";
import { ConvertTasksDto, ExtractTasksDto, SuggestTagsDto } from "./dto/ai.dto";

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

/**
 * The whole task as one sync document, keyed exactly like the REST path writes
 * it. `TASK_FIELDS` in the sync validator treats every key as optional, so a
 * partial payload passes validation and still lands wrong: a device applies an
 * absent key as nothing, and this loop's rows would arrive everywhere as a task
 * with no status, no dates and no tree position. Built from the row Prisma
 * returned, not from the request, so defaults the schema filled in (`status`,
 * `sortOrder`, `priority`) are echoed rather than invented.
 *
 * Duplicated from `taskChangePayload` in `src/tasks/services/tasks.service.ts`
 * on purpose: that builder is module-private, and the task module is not this
 * one's to change. If it ever gains a key, both lists need it.
 */
function taskChangeDocument(
  task: any,
  extractedFromNoteId: string,
): Record<string, any> {
  const asIso = (value: unknown): string | null =>
    value instanceof Date
      ? value.toISOString()
      : ((value ?? null) as string | null);

  return {
    title: task.title ?? "",
    description: task.description ?? null,
    priority: task.priority ?? "P4_LOW",
    status: task.status ?? "TODO",
    dueDate: asIso(task.dueDate),
    dueTime: task.dueTime ?? null,
    recurrenceRule: task.recurrenceRule ?? null,
    completedAt: asIso(task.completedAt),
    sectionId: task.sectionId ?? null,
    parentId: task.parentId ?? null,
    projectId: task.projectId ?? null,
    sortOrder: task.sortOrder ?? 0,
    timeSpentSeconds: task.timeSpentSeconds ?? 0,
    createdAt: asIso(task.createdAt),
    version: task.version ?? 1,
    extractedFromNoteId,
  };
}

@Injectable()
export class AiService {
  constructor(
    private readonly prisma: PrismaService,
    // `@Optional()` for the same reason the other write paths use it: this
    // service is constructed in unit graphs that register no sync module, and a
    // missing notifier costs the wake-up and nothing else.
    @Optional() private readonly syncNotifications?: SyncNotificationService,
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
      if (note.isEncrypted) {
        throw new BadRequestException(
          "Encrypted notes cannot be processed by AI text utilities.",
        );
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

  /**
   * Heuristic-only by design: this route has no Gemini code path, so
   * `provider` is the literal `"heuristic"` on every call, whatever
   * `GEMINI_API_KEY`, `GEMINI_MODEL` or `GEMINI_TIMEOUT_MS` are set to. Only
   * `summarize()` consults the provider. Wiring remote extraction up here
   * would need a budget decision, not just a call — see docs/API_REFERENCE.md
   * §12.
   */
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

  /**
   * Also heuristic-only: frequency-ranked tags plus keyword categories, with
   * no provider call, so `provider` is always `"heuristic"` here too.
   */
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

    let highestCursor: bigint | undefined;

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

        const logged = await appendChange(tx, {
          userId,
          entityType: "task",
          entityId: task.id,
          operation: ChangeOperation.CREATE,
          version: 1,
          payload: taskChangeDocument(task, noteId),
        });

        // Cursors only rise inside one transaction, so the last row written is
        // the end of the log — and one wake-up after commit covers every task
        // this loop appended.
        highestCursor = logged.cursor;

        results.push(task);
      }
      return results;
    });

    // `tasks: []` is valid input, and a wake-up that announces no new row just
    // costs every other device a pull that returns nothing.
    if (highestCursor !== undefined) {
      this.syncNotifications?.notifyMutation({ userId, highestCursor });
    }

    return {
      createdCount: createdTasks.length,
      tasks: createdTasks,
    };
  }
}
