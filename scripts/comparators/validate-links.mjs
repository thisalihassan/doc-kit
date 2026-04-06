import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { BASE, HEAD, TITLE } from '../constants.mjs';

const HREF_REGEX = /<[^>]*\bhref=(?:(["'])(.*?)\1|([^\s>]+))/g;
const ID_UNQUOTED_REGEX = /\bid=([a-zA-Z0-9_.:-]+)(?=[\s>]|$)/g;
const DOC_TARGET_REGEX =
  /^(?<target>[^#?]+?\.(?:html|md))(?:#(?<fragment>[a-zA-Z0-9_.:-]+))?$/;
const EXTERNAL_SCHEME_REGEX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export const DEFAULT_IGNORED_MISSING_TARGETS = new Set(
  (process.env.VALIDATE_LINKS_IGNORED_TARGETS ?? 'all.html')
    .split(',')
    .map(target => target.trim())
    .filter(Boolean)
);

/**
 * Extracts all `id` attribute values from an HTML string.
 * Handles both quoted (id="val") and unquoted/minified (id=val) forms.
 *
 * @param {string} html
 * @returns {Set<string>}
 */
export const extractIds = html => {
  const ids = new Set();
  for (const m of html.matchAll(/\bid=(["'])([^"']*?)\1/g)) {
    ids.add(m[2]);
  }
  for (const m of html.matchAll(ID_UNQUOTED_REGEX)) {
    if (!m[1].startsWith('"') && !m[1].startsWith("'")) {
      ids.add(m[1]);
    }
  }
  return ids;
};

/**
 * Extracts raw href values from an HTML string.
 *
 * @param {string} html
 * @returns {string[]}
 */
export const extractHrefs = html =>
  [...html.matchAll(HREF_REGEX)].map(match => match[2] ?? match[3]);

/**
 * Classifies a raw href value so we can validate local documentation links.
 *
 * @param {string} href
 * @returns {null | { type: 'same-file', fragment: string } | { type: 'cross-file', targetFile: string, fragment: string | null }}
 */
export const classifyHref = href => {
  if (
    !href ||
    href.startsWith('/') ||
    href.startsWith('//') ||
    href.startsWith('?') ||
    EXTERNAL_SCHEME_REGEX.test(href)
  ) {
    return null;
  }

  if (href.startsWith('#')) {
    return href.length > 1
      ? { type: 'same-file', fragment: href.slice(1) }
      : null;
  }

  const match = href.match(DOC_TARGET_REGEX);
  if (!match?.groups?.target) {
    return null;
  }

  return {
    type: 'cross-file',
    targetFile: match.groups.target,
    fragment: match.groups.fragment ?? null,
  };
};

/**
 * Diffs two broken-link sets.
 *
 * @param {Set<string>} baseBroken
 * @param {Set<string>} headBroken
 * @returns {{ newlyBroken: string[], fixed: string[], unchanged: string[] }}
 */
export const diffBrokenLinks = (baseBroken, headBroken) => ({
  newlyBroken: [...headBroken].filter(link => !baseBroken.has(link)).sort(),
  fixed: [...baseBroken].filter(link => !headBroken.has(link)).sort(),
  unchanged: [...headBroken].filter(link => baseBroken.has(link)).sort(),
});

/**
 * Scans all HTML files in a directory, returning a map of filename to its
 * set of anchor IDs and a flat set of all broken internal links.
 *
 * @param {string} dir
 * @param {{ ignoredMissingTargets?: Set<string> }} [options]
 * @returns {Promise<{ broken: Set<string>, total: number }>}
 */
export const collectBrokenLinks = async (
  dir,
  { ignoredMissingTargets = DEFAULT_IGNORED_MISSING_TARGETS } = {}
) => {
  const files = (await readdir(dir)).filter(f => f.endsWith('.html'));

  const fileIds = new Map();
  const fileHtml = new Map();

  await Promise.all(
    files.map(async file => {
      const html = await readFile(path.join(dir, file), 'utf8');
      fileIds.set(file, extractIds(html));
      fileHtml.set(file, html);
    })
  );

  const broken = new Set();
  let total = 0;

  for (const file of files) {
    const html = fileHtml.get(file);
    const ownIds = fileIds.get(file);

    for (const href of extractHrefs(html)) {
      const link = classifyHref(href);
      if (!link) {
        continue;
      }

      total++;

      if (link.type === 'same-file') {
        if (!ownIds.has(link.fragment)) {
          broken.add(`${file}#${link.fragment}`);
        }
        continue;
      }

      if (!fileIds.has(link.targetFile)) {
        if (!ignoredMissingTargets.has(link.targetFile)) {
          const suffix = link.fragment ? `#${link.fragment}` : '';
          broken.add(`${file}->${link.targetFile}${suffix}`);
        }
        continue;
      }

      if (link.fragment && !fileIds.get(link.targetFile).has(link.fragment)) {
        broken.add(`${file}->${link.targetFile}#${link.fragment}`);
      }
    }
  }

  return { broken, total };
};

/**
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
export const dirExists = async dir => {
  try {
    await access(dir);
    return true;
  } catch {
    return false;
  }
};

/**
 * Runs the comparator as a CLI.
 *
 * @param {{ base?: string, head?: string, title?: string, ignoredMissingTargets?: Set<string> }} [options]
 * @returns {Promise<number>}
 */
export const main = async ({
  base = BASE,
  head = HEAD,
  title = TITLE,
  ignoredMissingTargets = DEFAULT_IGNORED_MISSING_TARGETS,
} = {}) => {
  const hasBase = await dirExists(base);
  const headResult = await collectBrokenLinks(head, { ignoredMissingTargets });

  if (!hasBase) {
    console.log(title);
    console.log(`Checked **${headResult.total}** internal links.\n`);
    if (headResult.broken.size) {
      console.log(`**${headResult.broken.size}** broken links found:\n`);
      for (const link of [...headResult.broken].sort()) {
        console.log(`- \`${link}\``);
      }
    } else {
      console.log('No broken links found.');
    }
    return 0;
  }

  const baseResult = await collectBrokenLinks(base, { ignoredMissingTargets });
  const { newlyBroken, fixed, unchanged } = diffBrokenLinks(
    baseResult.broken,
    headResult.broken
  );

  console.log(title);
  console.log(
    `Checked **${headResult.total}** internal links across ` +
      `**${(await readdir(head)).filter(f => f.endsWith('.html')).length}** HTML files.\n`
  );

  if (fixed.length) {
    console.log(`<details>\n<summary>Links fixed: ${fixed.length}</summary>\n`);
    for (const link of fixed) {
      console.log(`- \`${link}\``);
    }
    console.log('\n</details>\n');
  }

  if (unchanged.length) {
    console.log(`Pre-existing broken links (unchanged): ${unchanged.length}\n`);
  }

  if (newlyBroken.length) {
    console.log(`**New broken links: ${newlyBroken.length}**\n`);
    for (const link of newlyBroken) {
      console.log(`- \`${link}\``);
    }
    console.log('');
    return 1;
  }

  console.log('No new broken links introduced.\n');
  return 0;
};

const isEntrypoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  process.exitCode = await main();
}
