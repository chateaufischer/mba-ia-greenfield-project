/** Forma da saída JSON do `ffprobe -print_format json -show_format -show_streams`. */
export interface FfprobeFormat {
  format_name?: string;
  duration?: string;
  size?: string;
  bit_rate?: string;
}

export interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}

export interface FfprobeOutput {
  format?: FfprobeFormat;
  streams?: FfprobeStream[];
}

/** Metadados destilados, no formato que a entidade `Video` persiste. */
export interface ProbedMetadata {
  duration_seconds: number | null;
  format_name?: string;
  bit_rate?: number;
  width?: number;
  height?: number;
  video_codec?: string;
  audio_codec?: string;
}
