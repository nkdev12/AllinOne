import { ErrorCode } from "@/common/errors/error-code";
import { createValidationPipe } from "@/common/errors/validation.pipe";
import { getMetadataStorage } from "class-validator";
import {
  ConvertTasksDto,
  ExtractTasksDto,
  MAX_TASKS_PER_CONVERSION,
  SuggestTagsDto,
} from "./ai.dto";

/**
 * The bounds on what one AI request may hand the server.
 *
 * `convert-tasks` is the only route in this module that writes, and it writes twice
 * per item — a `Task` row and a `Change` row — inside a single `$transaction`, so
 * the array's length is that transaction's size and, once committed, the number of
 * documents every other device of the account has to replay for the life of the
 * log. Without a cap, ~6k single-key `{ title }` items fit under body-parser's
 * default 100 kB and materialise thousands of rows from one call.
 */
describe("AI DTO array bounds", () => {
  const pipe = createValidationPipe();
  const context = (metatype: any) => ({ type: "body" as const, metatype });

  const convert = (count: number) =>
    pipe.transform(
      {
        tasks: Array.from({ length: count }, (_unused, n) => ({
          title: `Task ${n}`,
        })),
      },
      context(ConvertTasksDto) as any,
    );

  it("refuses a conversion longer than the cap", async () => {
    const error: any = await convert(MAX_TASKS_PER_CONVERSION + 1).catch(
      (e) => e,
    );

    // The pipe's contract, not a bare array: one fixed summary and the per-field
    // truth in `details.fields`, so this route answers the way the rest of the API
    // does. The message is the DTO's own, sentence-finished by the pipe.
    expect(error.getResponse().code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(error.getResponse().message).toBe(
      "Please correct the highlighted fields.",
    );
    expect(error.getResponse().details.fields).toEqual([
      {
        field: "tasks",
        messages: [
          `a conversion may carry at most ${MAX_TASKS_PER_CONVERSION} tasks.`,
        ],
      },
    ]);
  });

  it("takes a conversion of exactly the cap", async () => {
    const value = await convert(MAX_TASKS_PER_CONVERSION);
    expect(value.tasks).toHaveLength(MAX_TASKS_PER_CONVERSION);
  });

  /**
   * The gap was a decorator nobody wrote, so the assertion is about the metadata
   * rather than about one payload: every `@IsArray()` on this module's DTO surface
   * carries a size bound. A new list field without `@ArrayMaxSize` fails here.
   *
   * The `tasks` case at the end is the guard that this is reading the decorators and
   * not passing on an empty scan.
   */
  it("bounds every array field it declares", () => {
    const SIZE_BOUNDS = ["arrayMaxSize", "arrayMinSize", "arrayNotEmpty"];

    /**
     * A DTO class. Spelled as a shape rather than as `Function`, which the linter
     * bans for being indistinguishable from `any`.
     */
    type DtoClass = new (...args: any[]) => object;

    /** The constraint names declared on each array property of one DTO. */
    const arrayConstraints = (
      target: DtoClass,
    ): Array<{ property: string; names: Set<string> }> => {
      const metadatas = getMetadataStorage()
        .getTargetValidationMetadatas(target, target.name, true, false)
        .filter((metadata) => metadata.propertyName);

      const byProperty = new Map<string, Set<string>>();
      for (const metadata of metadatas) {
        const names =
          byProperty.get(metadata.propertyName) ?? new Set<string>();
        names.add(metadata.name ?? metadata.type);
        byProperty.set(metadata.propertyName, names);
      }

      return [...byProperty]
        .filter(([, names]) => names.has("isArray"))
        .map(([property, names]) => ({ property, names }));
    };

    const uncapped = [ExtractTasksDto, SuggestTagsDto, ConvertTasksDto].flatMap(
      (target) =>
        arrayConstraints(target)
          .filter(({ names }) => !SIZE_BOUNDS.some((bound) => names.has(bound)))
          .map(({ property }) => `${target.name}.${property}`),
    );

    expect(uncapped).toEqual([]);
    expect(
      arrayConstraints(ConvertTasksDto).map(({ property }) => property),
    ).toContain("tasks");
  });
});
