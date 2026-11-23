// 블로그(gawon-log) API 에서 공개 글 최신 3개를 읽어 README 의 BLOG-POSTS 칸을 카드 표로 갈아 끼움
// 표지는 홈서버에서 바로 불러오면 GitHub 이미지 프록시가 시간 초과로 끊겨서 assets/blog 에 복사해 둠
// 글이 그대로면 README 와 표지 파일이 한 바이트도 안 바뀌어야 봇 커밋이 생기지 않음
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SITE = 'https://gawon-dev.tail7c7524.ts.net';
const README = 'README.md';
const COVER_DIR = 'assets/blog';
const NO_COVER = 'no-cover.png';
const START = '<!-- BLOG-POSTS:START -->';
const END = '<!-- BLOG-POSTS:END -->';
const LIMIT = 3;
const TAG_LIMIT = 3;
const TIMEOUT_MS = 15_000;
// 새 표지를 만들어야 하는데 ImageMagick 이 없을 때의 종료 코드. 워크플로가 이걸 보고 설치 후 다시 돌림
const EXIT_NEEDS_IMAGEMAGICK = 3;

class NeedsImageMagick extends Error {}

// 홈서버 노트북이 꺼져 있는 건 흔한 일이라 실패로 치지 않고 경고만 남기고 그대로 둠
const skip = (reason) => {
  console.log(`::warning::${reason}. README 를 그대로 둠`);
  process.exit(0);
};

const escapeHtml = (text) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// 서울 날짜로 YYYY-MM-DD
const toSeoulDate = (iso) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });

// ImageMagick 7 은 magick, 6 은 convert
const imageMagick = ['magick', 'convert'].find((bin) => {
  try {
    execFileSync(bin, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
});

// 표지 이미지 ID 로 파일 이름을 정하고, 이미 있으면 다시 만들지 않음 (다시 인코딩하면 바이트가 달라질 수 있음)
const ensureCover = async (cover, workDir) => {
  if (!cover) return NO_COVER;
  const name = `${path.parse(cover).name}.png`;
  const target = path.join(COVER_DIR, name);
  if (existsSync(target)) return name;
  if (!imageMagick) throw new NeedsImageMagick(`새 표지 ${name} 을 만들 ImageMagick 이 없음`);

  const res = await fetch(`${SITE}${cover}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`표지 ${cover} 응답 ${res.status}`);
  const source = path.join(workDir, path.basename(cover));
  await writeFile(source, Buffer.from(await res.arrayBuffer()));

  // 다이어그램이 잘리지 않게 640x400 흰 바탕 안에 통째로 맞춰 넣음
  execFileSync(imageMagick, [
    source,
    '-resize', '600x370',
    '-background', 'white',
    '-gravity', 'center',
    '-extent', '640x400',
    '-depth', '8',
    '-strip',
    '-define', 'png:exclude-chunks=date,time',
    target,
  ]);
  return name;
};

const renderCard = (post, coverName) => {
  const url = `${SITE}/blog/posts/${post.id}`;
  const title = escapeHtml(post.title);
  const tags = post.tags.slice(0, TAG_LIMIT).map(escapeHtml).join(' · ');
  const meta = tags ? `${toSeoulDate(post.createdAt)} · ${tags}` : toSeoulDate(post.createdAt);
  return [
    `    <td width="33%" valign="top">`,
    `      <a href="${url}"><img src="${COVER_DIR}/${coverName}" width="100%" alt="${title}" /></a><br/>`,
    `      <a href="${url}"><b>${title}</b></a><br/>`,
    `      <sub>${meta}</sub>`,
    `    </td>`,
  ].join('\n');
};

let posts;
try {
  const res = await fetch(`${SITE}/api/blog/posts`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) skip(`블로그 API 응답 ${res.status}`);
  ({ posts } = await res.json());
} catch (err) {
  skip(`블로그 API 를 못 읽음 (${err.message})`);
}

// 잠긴 글, 허락받은 사람만 읽는 글은 빼고 누구나 읽는 글만 씀
const openPosts = posts
  .filter((post) => post.visibility === 'public' && !post.locked)
  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  .slice(0, LIMIT);

// API 가 비어 오면 장애일 수 있으니 기존 목록을 지우지 않음
if (openPosts.length === 0) skip('공개 글이 0개로 옴');

const workDir = await mkdtemp(path.join(tmpdir(), 'blog-covers-'));
let coverNames;
let coverError;
try {
  coverNames = await Promise.all(openPosts.map((post) => ensureCover(post.cover, workDir)));
} catch (err) {
  coverError = err;
} finally {
  await rm(workDir, { recursive: true, force: true });
}
if (coverError instanceof NeedsImageMagick) {
  console.log(coverError.message);
  process.exit(EXIT_NEEDS_IMAGEMAGICK);
}
if (coverError) skip(`표지를 못 만듦 (${coverError.message})`);

// 목록에서 빠진 글의 표지는 지움
const keep = new Set([NO_COVER, ...coverNames]);
for (const file of await readdir(COVER_DIR)) {
  if (!keep.has(file)) await rm(path.join(COVER_DIR, file));
}

const table = [
  '<table>',
  '  <tr>',
  ...openPosts.map((post, i) => renderCard(post, coverNames[i])),
  '  </tr>',
  '</table>',
].join('\n');

const readme = await readFile(README, 'utf8');
const start = readme.indexOf(START);
const end = readme.indexOf(END);
if (start === -1 || end === -1 || end < start) throw new Error('README 에 BLOG-POSTS 표시가 없음');

const next = `${readme.slice(0, start + START.length)}\n${table}\n${readme.slice(end)}`;
if (next === readme) {
  console.log('바뀐 글 없음');
} else {
  await writeFile(README, next);
  console.log(`최근 글 ${openPosts.length}개로 갱신함: ${openPosts.map((post) => post.title).join(', ')}`);
}
