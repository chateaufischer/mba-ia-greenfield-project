import { ArrayMaxSize, ArrayNotEmpty, IsInt, Min } from 'class-validator';

export const MAX_PART_URLS_PER_REQUEST = 100;

export class UploadPartsDto {
  /** Números das partes (1-based) para as quais emitir URLs pré-assinadas. Ex.: `[1, 2, 3]`. */
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_PART_URLS_PER_REQUEST)
  @IsInt({ each: true })
  @Min(1, { each: true })
  part_numbers: number[];
}
