import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from "class-validator";

export class CreateFolderDto {
  @ApiProperty({
    example: "Personal Notes",
    description: "Folder display name",
  })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({
    example: "123e4567-e89b-12d3-a456-426614174000",
    description: "Parent folder UUID",
  })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional({
    example: "#FF5733",
    description: "Folder color hex code",
  })
  @IsOptional()
  @IsString()
  color?: string;

  @ApiPropertyOptional({
    example: "folder-heart",
    description: "Folder icon name",
  })
  @IsOptional()
  @IsString()
  icon?: string;

  @ApiPropertyOptional({
    example: 0,
    description: "Display sort order position",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
