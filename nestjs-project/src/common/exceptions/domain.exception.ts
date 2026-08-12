export abstract class DomainException extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor() {
    super('EMAIL_ALREADY_EXISTS', 409, 'Email is already registered');
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor() {
    super('EMAIL_NOT_CONFIRMED', 403, 'Email address has not been confirmed');
  }
}

export class InvalidTokenException extends DomainException {
  constructor() {
    super('INVALID_TOKEN', 401, 'Token is invalid');
  }
}

export class TokenExpiredException extends DomainException {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Token has expired');
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor() {
    super(
      'TOKEN_REUSE_DETECTED',
      401,
      'Token reuse detected — all sessions revoked',
    );
  }
}

// --- Fase 03: upload e processamento de vídeos ---

export class ChannelNotFoundException extends DomainException {
  constructor() {
    super('CHANNEL_NOT_FOUND', 404, 'User does not have a channel');
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoNotOwnedException extends DomainException {
  constructor() {
    super('VIDEO_NOT_OWNED', 403, 'Video belongs to another channel');
  }
}

export class UploadTooLargeException extends DomainException {
  constructor(maxBytes: number) {
    super(
      'UPLOAD_TOO_LARGE',
      413,
      `Video exceeds the maximum upload size of ${maxBytes} bytes`,
    );
  }
}

export class UnsupportedMediaTypeException extends DomainException {
  constructor() {
    super('UNSUPPORTED_MEDIA_TYPE', 415, 'Only video content types are accepted');
  }
}

export class UploadNotOpenException extends DomainException {
  constructor() {
    super('UPLOAD_NOT_OPEN', 409, 'There is no open upload for this video');
  }
}

export class InvalidUploadPartsException extends DomainException {
  constructor(reason: string) {
    super('INVALID_UPLOAD_PARTS', 400, `Invalid upload parts: ${reason}`);
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video has not finished processing');
  }
}

export class PublicIdGenerationFailedException extends DomainException {
  constructor() {
    super(
      'PUBLIC_ID_GENERATION_FAILED',
      500,
      'Could not generate a unique public id for the video',
    );
  }
}
