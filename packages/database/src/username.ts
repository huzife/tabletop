export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;

const USERNAME_CHARACTERS = /^[\p{Script=Han}A-Za-z0-9_-]+$/u;

export type UsernameValidationCode = "USERNAME_LENGTH" | "USERNAME_CHARACTERS";

export class UsernameValidationError extends Error {
  readonly code: UsernameValidationCode;

  constructor(code: UsernameValidationCode, message: string) {
    super(message);
    this.name = "UsernameValidationError";
    this.code = code;
  }
}

export interface NormalizedUsername {
  readonly display: string;
  readonly normalized: string;
}

export function normalizeUsername(input: string): NormalizedUsername {
  const display = input.trim().normalize("NFKC");
  const length = Array.from(display).length;

  if (length < USERNAME_MIN_LENGTH || length > USERNAME_MAX_LENGTH) {
    throw new UsernameValidationError(
      "USERNAME_LENGTH",
      `用户名长度必须为 ${USERNAME_MIN_LENGTH} 到 ${USERNAME_MAX_LENGTH} 个字符`,
    );
  }

  if (!USERNAME_CHARACTERS.test(display)) {
    throw new UsernameValidationError(
      "USERNAME_CHARACTERS",
      "用户名只能包含中文、英文字母、数字、下划线和短横线",
    );
  }

  return {
    display,
    normalized: display.replace(/[A-Z]/g, (character) => character.toLowerCase()),
  };
}

export function isValidUsername(input: string): boolean {
  try {
    normalizeUsername(input);
    return true;
  } catch (error) {
    if (error instanceof UsernameValidationError) {
      return false;
    }
    throw error;
  }
}
