import { IsInt, IsNotEmpty, IsString, Length, Min } from 'class-validator';

export class CreateVideoDto {
  /** Título do vídeo. Ex.: `Minha primeira gravação`. */
  @IsString()
  @Length(3, 150)
  title: string;

  /** Nome do arquivo original; usado só para derivar a extensão da chave no storage. Ex.: `holiday.mp4`. */
  @IsString()
  @IsNotEmpty()
  filename: string;

  /**
   * Media type do arquivo. Ex.: `video/mp4`.
   *
   * A regra "precisa ser `video/*`" é de domínio, não de schema: o Error
   * Catalog da fase mapeia a violação para `415 UNSUPPORTED_MEDIA_TYPE`, e
   * validá-la aqui a transformaria num `400 VALIDATION_ERROR`.
   */
  @IsString()
  @IsNotEmpty()
  content_type: string;

  /** Tamanho do arquivo em bytes, declarado pelo cliente. Ex.: `1073741824`. */
  @IsInt()
  @Min(1)
  size_bytes: number;
}
