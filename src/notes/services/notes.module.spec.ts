import { Test } from "@nestjs/testing";
import { NotesModule } from "../notes.module";
import { NotesService } from "./notes.service";
import { CollaborationModule } from "@/collaboration/collaboration.module";

/**
 * `NotesModule` has no `CollaborationModule` in its `imports`, and that is what
 * made the sharing fallbacks inside `NotesService` look like dead code. They are
 * not: `CollaborationModule` is `@Global()`, so everything it exports is
 * resolvable in every module of an app that registers it — which is what
 * `AppModule` does, and what this reproduces at the smallest scale that still
 * exercises the real mechanism.
 *
 * Worth pinning because the alternative is a silent failure with no symptom to
 * notice: drop `CollaborationModule` from `AppModule`, and because the injection
 * is `@Optional()`, the app still boots and every shared note becomes a 404 for
 * the people it was shared with.
 */
describe("NotesModule's collaborators", () => {
  it("resolves the sharing service without importing its module", async () => {
    const module = await Test.createTestingModule({
      imports: [CollaborationModule, NotesModule],
    }).compile();

    const notes = module.get(NotesService, { strict: false });

    expect(notes).toBeDefined();
    // Read through the constructor argument rather than a public method: this is
    // about whether Nest had something to hand it.
    expect((notes as any).collaborationService).toBeDefined();
  });
});
