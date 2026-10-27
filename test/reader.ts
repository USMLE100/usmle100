/** Read a Course Book chapter the way the reader does: open a reading session, fetch once, unscramble. */
export async function readChapter(req: (path: string, opts?: any) => Promise<Response>, cookie: string, chapterId: number) {
  const page = await req(`/course-book/${chapterId}/read`, { cookie });
  if (page.status !== 200) return { status: page.status, bytes: null as Uint8Array | null, session: '' };
  const html = await page.text();
  const m = /data-session="([^"]+)"/.exec(html);
  if (!m) return { status: 403, bytes: null, session: '' };
  const session = m[1];
  const key = new Uint8Array(/data-key="([0-9a-f]{64})"/.exec(html)![1].match(/../g)!.map((h) => parseInt(h, 16)));
  const res = await req(`/course-book/${chapterId}/data?s=${session}`, { cookie });
  if (res.status !== 200) return { status: res.status, bytes: null, session };
  const raw = new Uint8Array(await res.arrayBuffer());
  const bytes = raw.map((b, i) => b ^ key[i & 31] ^ ((i * 7) & 255));
  return { status: 200, bytes, raw, session, html };
}
