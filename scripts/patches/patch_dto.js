const fs = require('fs');
const path = './src/auth/dto/verify-email.dto.ts';
let code = fs.readFileSync(path, 'utf8');

code = code.replace(
  /export class ConfirmEmailDto \{[\s\S]*?\}/,
  `export class ConfirmEmailDto {
  @ApiPropertyOptional({ description: "Email verification token received via email (if using link)" })
  @IsString()
  @IsOptional()
  token?: string;

  @ApiPropertyOptional({ description: "User email (if using OTP)" })
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiPropertyOptional({ description: "6-digit OTP code received via email" })
  @IsString()
  @IsOptional()
  otp?: string;
}`
);

code = `import { IsEmail, IsNotEmpty, IsString, IsOptional } from "class-validator";\nimport { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";\n` + code.replace(/import \{.*?\} from "class-validator";\n/, '').replace(/import \{.*?\} from "@nestjs\/swagger";\n/, '');

fs.writeFileSync(path, code);
