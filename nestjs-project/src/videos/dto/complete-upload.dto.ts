import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class UploadedPartDto {
  /** Número da parte (1-based), como enviado ao storage. */
  @IsInt()
  @Min(1)
  part_number: number;

  /** ETag devolvido pelo storage no `PUT` da parte. */
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  /** Partes enviadas, na ordem em que devem ser consolidadas. */
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => UploadedPartDto)
  parts: UploadedPartDto[];
}
