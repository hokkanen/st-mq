import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Ignore examples in fenced code blocks while preserving diagnostic line numbers.
function prose(text) {
  let fence;
  return text.split('\n').map(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length
        && line.slice(marker[0].length).trim() === '') fence = null;
      return '';
    }
    if (marker) { fence = marker[1]; return ''; }
    return line;
  }).join('\n');
}

function anchors(text) {
  const result = new Set(), slugs = new Set();
  for (const match of text.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) result.add(match[1]);
  for (const match of text.matchAll(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/gm)) {
    const base = match[1].replace(/<[^>]*>/g, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, '').replace(/ /g, '-');
    let slug = base, suffix = 0;
    while (slugs.has(slug)) slug = `${base}-${++suffix}`;
    slugs.add(slug); result.add(slug);
  }
  return result;
}

/** Check literal relative Markdown links/images against versioned public paths.
 * External URLs are intentionally not fetched by an offline repository check. */
export function checkDocumentation({ root, paths }) {
  root = resolve(root);
  const publicPaths = new Set(paths), texts = new Map(), targets = new Map(), errors = [];
  for (const path of paths.filter(path => path.endsWith('.md'))) {
    const text = prose(readFileSync(resolve(root, path), 'utf8'));
    texts.set(path, text); targets.set(path, anchors(text));
  }
  let links = 0;
  for (const [path, text] of texts) {
    // Repository docs use inline links, with optional titles or angle brackets.
    for (const match of text.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\s*\)/g)) {
      const destination = match[1].replace(/^<|>$/g, '');
      if (/^(?:[a-z][\w+.-]*:|\/\/)/i.test(destination)) continue;
      links++;
      const line = text.slice(0, match.index).split('\n').length;
      const fail = reason => errors.push(`${path}:${line}: ${reason}: ${destination}`);
      let localPath, fragment;
      try {
        const hash = destination.indexOf('#');
        localPath = decodeURIComponent((hash < 0 ? destination : destination.slice(0, hash)).split('?')[0]);
        fragment = hash < 0 ? '' : decodeURIComponent(destination.slice(hash + 1));
      } catch { fail('invalid URL encoding'); continue; }
      const absolute = localPath ? resolve(localPath.startsWith('/') ? root : dirname(resolve(root, path)),
        localPath.replace(/^\//, '')) : resolve(root, path);
      const target = relative(root, absolute).split(sep).join('/');
      const directory = `${target.replace(/\/$/, '')}/`;
      if (target === '..' || target.startsWith('../') || !publicPaths.has(target)
        && target !== '' && !paths.some(candidate => candidate.startsWith(directory))) {
        fail('target is not versioned'); continue;
      }
      if (fragment && targets.has(target) && !targets.get(target).has(fragment)) fail('missing heading or anchor');
    }
  }
  return { files: texts.size, links, errors };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const result = checkDocumentation({ root, paths });
  for (const error of result.errors) console.error(error);
  console.log(`Checked ${result.links} local links in ${result.files} Markdown files; ${result.errors.length} errors.`);
  process.exitCode = result.errors.length ? 1 : 0;
}
