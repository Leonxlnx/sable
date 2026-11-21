import { describe, expect, it } from 'vitest';
import { readErrorDetail } from '../src/features/timeline/error-detail';

describe('readErrorDetail', () => {
  it('reads an API failure: the words and the status', () => {
    const raw = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
    expect(readErrorDetail(raw)).toEqual({ text: 'Overloaded', status: '529', raw });
  });
  it('reads flat bodies', () => {
    expect(readErrorDetail('500 {"message":"Internal server error"}')).toMatchObject({ text: 'Internal server error', status: '500' });
    expect(readErrorDetail('{"error":"rate limited"}')).toMatchObject({ text: 'rate limited', status: undefined });
  });
  it('leaves everything else as it came', () => {
    for (const t of ['spawn ENOENT', 'exit code 1 {', 'Error: {not json}', 'API Error: 500 {"ok":true}', 'see {"a":1} above']) expect(readErrorDetail(t)).toEqual({ text: t });
  });
});
