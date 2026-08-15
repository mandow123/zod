import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors.js';

export type ListingCursor = Readonly<{ createdAt: string; id: string }>;

export class CursorService {
  constructor(private readonly secret: string) {}

  encode(cursor: ListingCursor) {
    const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    const signature = createHmac('sha256', this.secret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  decode(value: string | undefined): ListingCursor | null {
    if (!value) return null;
    const [payload, signature] = value.split('.');
    if (!payload || !signature) throw new AppError('PAGINATION_CURSOR_INVALID', 400, '分页位置无效，请重新加载。');
    const expected = createHmac('sha256', this.secret).update(payload).digest('base64url');
    const left = Buffer.from(signature);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      throw new AppError('PAGINATION_CURSOR_INVALID', 400, '分页位置无效，请重新加载。');
    }
    try {
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<ListingCursor>;
      if (typeof parsed.id !== 'string' || typeof parsed.createdAt !== 'string' || Number.isNaN(Date.parse(parsed.createdAt))) throw new Error('invalid cursor');
      return { id: parsed.id, createdAt: parsed.createdAt };
    } catch {
      throw new AppError('PAGINATION_CURSOR_INVALID', 400, '分页位置无效，请重新加载。');
    }
  }
}
