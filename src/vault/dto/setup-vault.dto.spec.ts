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

  it("accepts a base64 recovery salt alongside the wrap", async () => {
    await expect(
      setup({
        recoveryKdfSalt: "c2FsdF9iYXNlNjRfc3RyaW5n",
        wrappedMasterKey: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAh",
        wrappedMasterIv: "AQIDBAUGBwgJCgsMDQ4PEA==",
        wrappedMasterTag: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=",
      }),
    ).resolves.toMatchObject({ recoveryKdfSalt: "c2FsdF9iYXNlNjRfc3RyaW5n" });
  });

  it("refuses a setup that uploads an unwrapped recovery key", async () => {
    // Storing this would let anyone with database access open every vault, so
    // the field is not merely ignored — it fails the request outright.
    await expect(
      setup({ recoveryKey: "c3VwZXItc2VjcmV0LWtleS1tYXRlcmlhbCE=" }),
    ).rejects.toThrow(BadRequestException);
  });

  it.each([
    ["shorter than the client derives", "bmV3LXNhbHQ="],
    ["not base64 at all", "------------------------"],
  ])(
    "refuses a password salt %s, because recovery/complete would reject it",
    async (_label, keySalt) => {
      // `recovery/verify` returns this stored value and `recovery/complete`
      // demands 24 base64 characters of it, so accepting a salt that cannot come
      // back makes recovery fail months after the setup that caused it.
      await expect(setup({ keySalt })).rejects.toThrow(BadRequestException);
    },
  );
});
