import { BadRequestException } from "@nestjs/common";
import { createValidationPipe } from "@/common/errors/validation.pipe";
import { SetupVaultDto } from "./setup-vault.dto";

describe("SetupVaultDto", () => {
  const pipe = createValidationPipe();
  const context = { type: "body" as const, metatype: SetupVaultDto };

  const setup = (fields: Record<string, unknown>) =>
    pipe.transform(
      {
        masterKeyHash: "q7L1Z3mYxk1hZ8jH0lYXn0K8pQe1o2uW3r5t7y9b0cA=",
        keySalt: "c2FsdF9iYXNlNjRfc3RyaW5n",
        ...fields,
      },
      context,
    );

  it("accepts the Argon2id time cost a real client derives with", async () => {
    // `t = 3` is what every blob on this build was sealed with. The floor here
    // used to be 1000 — a PBKDF2-shaped minimum that would have rejected the
    // only honest value the client can report, which is how the row came to
    // hold the server's fallback instead of the truth.
    await expect(
      setup({ kdfIterations: 3, kdfMemory: 65536 }),
    ).resolves.toMatchObject({ kdfIterations: 3, kdfMemory: 65536 });
  });

  it("reports a zero time cost rather than storing it", async () => {
    await expect(setup({ kdfIterations: 0 })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("still accepts a setup that says nothing about its KDF", async () => {
    // Older builds omit both fields; refusing them would brick vault setup.
    await expect(setup({})).resolves.toMatchObject({
      keySalt: "c2FsdF9iYXNlNjRfc3RyaW5n",
    });
  });
});
