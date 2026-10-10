import { Test, TestingModule } from "@nestjs/testing";
import { OtpService } from "./otp.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { OtpPurpose } from "@prisma/client";
import * as crypto from "crypto";

describe("OtpService", () => {
  let service: OtpService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      otpToken: {
        upsert: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [OtpService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<OtpService>(OtpService);
  });

  it("issues a 6-digit OTP and stores its hash with attempts reset to 0", async () => {
    const code = await service.issue("user-1", OtpPurpose.PASSWORD_RESET, 15);

    expect(code).toMatch(/^\d{6}$/);
    expect(prisma.otpToken.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_purpose: {
            userId: "user-1",
            purpose: OtpPurpose.PASSWORD_RESET,
          },
        },
        create: expect.objectContaining({
          userId: "user-1",
          purpose: OtpPurpose.PASSWORD_RESET,
          attempts: 0,
        }),
        update: expect.objectContaining({
          attempts: 0,
        }),
      }),
    );
  });

  it("consumes successfully with correct code and deletes the token", async () => {
    const rawCode = "123456";
    const codeHash = crypto.createHash("sha256").update(rawCode).digest("hex");

    prisma.otpToken.findUnique.mockResolvedValue({
      userId: "user-1",
      purpose: OtpPurpose.PASSWORD_RESET,
      codeHash,
      attempts: 0,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    const result = await service.consume(
      "user-1",
      OtpPurpose.PASSWORD_RESET,
      "123456",
    );

    expect(result).toBe(true);
    expect(prisma.otpToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", purpose: OtpPurpose.PASSWORD_RESET },
    });
  });

  it("rejects when token is expired and cleans it up", async () => {
    const rawCode = "123456";
    const codeHash = crypto.createHash("sha256").update(rawCode).digest("hex");

    prisma.otpToken.findUnique.mockResolvedValue({
      userId: "user-1",
      purpose: OtpPurpose.PASSWORD_RESET,
      codeHash,
      attempts: 0,
      expiresAt: new Date(Date.now() - 1000),
    });

    const result = await service.consume(
      "user-1",
      OtpPurpose.PASSWORD_RESET,
      "123456",
    );

    expect(result).toBe(false);
    expect(prisma.otpToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", purpose: OtpPurpose.PASSWORD_RESET },
    });
  });

  it("increments attempts on incorrect code without deleting token before max", async () => {
    const correctCode = "123456";
    const codeHash = crypto
      .createHash("sha256")
      .update(correctCode)
      .digest("hex");

    prisma.otpToken.findUnique.mockResolvedValue({
      userId: "user-1",
      purpose: OtpPurpose.PASSWORD_RESET,
      codeHash,
      attempts: 1,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    const result = await service.consume(
      "user-1",
      OtpPurpose.PASSWORD_RESET,
      "999999",
    );

    expect(result).toBe(false);
    expect(prisma.otpToken.update).toHaveBeenCalledWith({
      where: {
        userId_purpose: {
          userId: "user-1",
          purpose: OtpPurpose.PASSWORD_RESET,
        },
      },
      data: { attempts: { increment: 1 } },
    });
    expect(prisma.otpToken.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes token and returns false when max attempts reached on incorrect code", async () => {
    const correctCode = "123456";
    const codeHash = crypto
      .createHash("sha256")
      .update(correctCode)
      .digest("hex");

    prisma.otpToken.findUnique.mockResolvedValue({
      userId: "user-1",
      purpose: OtpPurpose.PASSWORD_RESET,
      codeHash,
      attempts: 4, // 5th attempt will reach MAX_ATTEMPTS
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    const result = await service.consume(
      "user-1",
      OtpPurpose.PASSWORD_RESET,
      "999999",
    );

    expect(result).toBe(false);
    expect(prisma.otpToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", purpose: OtpPurpose.PASSWORD_RESET },
    });
  });
});
