import { BadRequestException } from "@nestjs/common";
import { IsEmail, MinLength } from "class-validator";
import { ErrorCode } from "./error-code";
import { createValidationPipe } from "./validation.pipe";

class RegisterBody {
  @IsEmail()
  email!: string;

  @MinLength(8)
  password!: string;
}

describe("createValidationPipe", () => {
  const pipe = createValidationPipe();
  const context = { type: "body" as const, metatype: RegisterBody };

  it("passes a valid body through", async () => {
    const value = await pipe.transform(
      { email: "swamy@example.com", password: "longenough" },
      context,
    );

    expect(value).toBeInstanceOf(RegisterBody);
    expect(value.email).toBe("swamy@example.com");
  });

  it("reports each failing field with a path and its messages", async () => {
    expect.assertions(4);
    try {
      await pipe.transform(
        { email: "not-an-email", password: "short" },
        context,
      );
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const response = (error as BadRequestException).getResponse() as any;
      expect(response.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(response.details.fields).toEqual(
        expect.arrayContaining([
          { field: "email", messages: ["must be an email"] },
          {
            field: "password",
            messages: ["must be longer than or equal to 8 characters"],
          },
        ]),
      );
      expect(response.message).toEqual(
        expect.arrayContaining(["email: must be an email"]),
      );
    }
  });

  it("names unknown properties instead of silently dropping them", async () => {
    expect.assertions(2);
    try {
      await pipe.transform(
        { email: "swamy@example.com", password: "longenough", isAdmin: true },
        context,
      );
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const response = (error as BadRequestException).getResponse() as any;
      expect(response.message.join(" ")).toContain("isAdmin");
    }
  });

  it("passes raw values that have no DTO shape straight through", async () => {
    const value = await pipe.transform("an-id", {
      type: "param" as const,
      metatype: String,
    } as never);

    expect(value).toBe("an-id");
  });
});
