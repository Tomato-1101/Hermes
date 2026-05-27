import { ulid } from 'ulid';

/** Generate a new ULID-based id for Flow / Step. */
export const newId = (): string => ulid();
